#!/usr/bin/env python3
"""
download_aneel.py — official ANEEL public dataset downloader for GridRisk

Supports two public sources used by the project:
  - BDGD via ANEEL ArcGIS portal (File Geodatabase downloads)
  - DEC/FEC continuity indicators via ANEEL CKAN open-data portal

Examples:
    python download_aneel.py bdgd --query ENEL_CE --ano 2024 --saida /data/enel_ce_2024.gdb.zip
    python download_aneel.py bdgd --item-id f9d38bba5dcb4525bcf19b03666197da --listar
    python download_aneel.py continuidade --saida /data/indicadores_continuidade.csv
"""

from __future__ import annotations

import logging
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import click
import requests
from requests import Response
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

ANEEL_ARCGIS_SEARCH_URL = "https://aneel.maps.arcgis.com/sharing/rest/search"
ANEEL_ARCGIS_ITEM_URL = "https://aneel.maps.arcgis.com/sharing/rest/content/items/{item_id}"
ANEEL_ARCGIS_ITEM_DATA_URL = "https://aneel.maps.arcgis.com/sharing/rest/content/items/{item_id}/data"
ANEEL_CKAN_PACKAGE_SHOW_URL = "https://dadosabertos.aneel.gov.br/api/3/action/package_show"
DEFAULT_CONTINUIDADE_PACKAGE = "indicadores-coletivos-de-continuidade-dec-e-fec"
DEFAULT_INDQUAL_PACKAGE = "indqual-municipio"
DEFAULT_DEST_DIR = Path("/data")
REQUEST_TIMEOUT = 120
CHUNK_SIZE = 2 * 1024 * 1024


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _request_json(
    url: str,
    params: dict[str, Any] | None = None,
    *,
    retries: int = 3,
) -> Any:
    """GET JSON with simple retry logic for public APIs."""
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as exc:
            last_error = exc
            if attempt == retries:
                break
            sleep_for = 2**attempt
            log.warning(
                "Request failed (%s). Retrying in %ss (%d/%d)...",
                exc,
                sleep_for,
                attempt,
                retries,
            )
            time.sleep(sleep_for)
    raise RuntimeError(f"Failed to fetch JSON from {url}: {last_error}")


def _safe_filename(value: str, default: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    cleaned = cleaned.strip("._")
    return cleaned or default


def _filename_from_headers(response: Response) -> str | None:
    disposition = response.headers.get("Content-Disposition", "")
    match = re.search(r'filename="?([^";]+)"?', disposition)
    if match:
        return match.group(1).strip()
    return None


def _resolve_output_path(saida: Path | None, diretorio: Path, fallback_name: str) -> Path:
    if saida:
        return saida
    return diretorio / fallback_name


def _ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _format_arcgis_time(value: Any) -> str:
    if value in (None, ""):
        return "-"
    try:
        millis = int(value)
        return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    except (ValueError, TypeError, OSError):
        return str(value)


def _extract_reference_years(item: dict[str, Any]) -> list[int]:
    """
    Extract dataset reference years from title/tags using hyphenated dates.

    This avoids mistaking build timestamps like 20250822 for the actual BDGD
    reference date like 2024-12-31.
    """
    haystack = " ".join(
        [
            str(item.get("title") or ""),
            " ".join(str(tag) for tag in item.get("tags", [])),
        ]
    )
    years: list[int] = []
    for year_text, _month, _day in re.findall(r"\b(20\d{2})-(\d{2})-(\d{2})\b", haystack):
        try:
            years.append(int(year_text))
        except ValueError:
            continue
    return years


def _bdgd_sort_key(item: dict[str, Any], ano: int | None) -> tuple[int, int, int]:
    years = _extract_reference_years(item)
    exact_year_match = 1 if ano is not None and ano in years else 0
    best_year = max(years) if years else 0
    modified = int(item.get("modified") or 0)
    return (exact_year_match, best_year, modified)


def _is_primary_continuity_resource(resource: dict[str, Any]) -> bool:
    name = str(resource.get("name") or "").lower()
    url = str(resource.get("url") or "").lower()
    noise_terms = ("atributos", "compensacao", "limite", "dominio", "dicionario")
    return "indicadores-continuidade-coletivos-" in (name or url) and not any(
        term in name or term in url for term in noise_terms
    )


def _continuity_sort_key(resource: dict[str, Any]) -> tuple[int, int, str]:
    name = str(resource.get("name") or "").lower()
    primary = 1 if _is_primary_continuity_resource(resource) else 0
    periods = re.findall(r"(20\d{2})-(20\d{2})", name)
    end_year = max((int(end) for _start, end in periods), default=0)
    modified = str(resource.get("last_modified") or resource.get("created") or "")
    return (primary, end_year, modified)


def _matches_continuity_type(resource: dict[str, Any], tipo: str) -> bool:
    name = str(resource.get("name") or "").lower()
    url = str(resource.get("url") or "").lower()
    text = f"{name} {url}"

    if tipo == "apurado":
        return _is_primary_continuity_resource(resource)
    if tipo == "limite":
        return "limite" in text
    if tipo == "compensacao":
        return "compensacao" in text
    if tipo == "atributos":
        return "atributos" in text
    if tipo == "dominio":
        return "dominio" in text
    return False


def _select_csv_resource(
    package_id: str,
    *,
    resource_id: str | None,
    selector,
    sort_key,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = _request_json(
        ANEEL_CKAN_PACKAGE_SHOW_URL,
        params={"id": package_id},
    )

    if not payload.get("success"):
        raise click.ClickException(f"CKAN package_show failed for package '{package_id}'.")

    resources = payload.get("result", {}).get("resources", [])
    csv_resources = [
        resource
        for resource in resources
        if str(resource.get("format") or "").lower() == "csv"
        or str(resource.get("url") or "").lower().endswith(".csv")
    ]
    if not csv_resources:
        raise click.ClickException(f"No CSV resources found in CKAN package '{package_id}'.")

    selected: dict[str, Any] | None = None
    if resource_id:
        for resource in csv_resources:
            if str(resource.get("id")) == resource_id:
                selected = resource
                break
        if selected is None:
            raise click.ClickException(
                f"Resource '{resource_id}' was not found in package '{package_id}'."
            )
        return selected, csv_resources

    matched_resources = [resource for resource in csv_resources if selector(resource)]
    if not matched_resources:
        raise click.ClickException(
            f"No CSV resources matching the selected criteria were found in package '{package_id}'."
        )

    return sorted(matched_resources, key=sort_key, reverse=True)[0], csv_resources


def _download_stream(url: str, destination: Path, *, force: bool) -> Path:
    if destination.exists() and not force:
        raise click.ClickException(
            f"Output file '{destination}' already exists. Use --forca to overwrite."
        )

    _ensure_parent_dir(destination)
    temp_destination = destination.with_suffix(destination.suffix + ".part")
    if temp_destination.exists():
        temp_destination.unlink()

    log.info("Downloading %s", url)
    with requests.get(url, stream=True, timeout=REQUEST_TIMEOUT) as response:
        response.raise_for_status()
        total_size = int(response.headers.get("Content-Length") or 0)
        header_filename = _filename_from_headers(response)
        if header_filename and destination.name != header_filename and destination == temp_destination.parent / destination.name:
            log.info("Server filename: %s", header_filename)

        with open(temp_destination, "wb") as handle, tqdm(
            total=total_size if total_size > 0 else None,
            unit="B",
            unit_scale=True,
            unit_divisor=1024,
            desc=destination.name,
        ) as progress:
            for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                if not chunk:
                    continue
                handle.write(chunk)
                progress.update(len(chunk))

    temp_destination.replace(destination)
    log.info("Saved file to %s", destination)
    return destination


def _select_bdgd_item(
    query: str | None,
    ano: int | None,
    item_id: str | None,
) -> dict[str, Any]:
    if item_id:
        payload = _request_json(
            ANEEL_ARCGIS_ITEM_URL.format(item_id=item_id),
            params={"f": "json"},
        )
        if str(payload.get("type")) != "File Geodatabase":
            raise click.ClickException(
                f"ArcGIS item '{item_id}' is not a File Geodatabase (type={payload.get('type')})."
            )
        return payload

    if not query:
        raise click.ClickException("Informe --query ou --item-id para localizar a BDGD oficial.")

    search_query = f'owner:aneel_aneel AND type:"File Geodatabase" AND ({query})'
    payload = _request_json(
        ANEEL_ARCGIS_SEARCH_URL,
        params={
            "q": search_query,
            "f": "json",
            "num": 50,
            "sortField": "modified",
            "sortOrder": "desc",
        },
    )

    results = [item for item in payload.get("results", []) if item.get("type") == "File Geodatabase"]
    if ano is not None:
        exact_matches = [item for item in results if ano in _extract_reference_years(item)]
        if exact_matches:
            results = exact_matches

    if not results:
        raise click.ClickException(
            f"Nenhuma BDGD encontrada para query='{query}'"
            + (f" e ano={ano}" if ano is not None else "")
            + "."
        )

    return sorted(results, key=lambda item: _bdgd_sort_key(item, ano), reverse=True)[0]


@click.group()
def cli() -> None:
    """Download public ANEEL datasets used by GridRisk."""


@cli.command("bdgd")
@click.option("--query", default=None, help="Search term for the ArcGIS portal (e.g. ENEL_CE).")
@click.option("--ano", type=int, default=None, help="Prefer results whose metadata mentions this year.")
@click.option("--item-id", default=None, help="Exact ArcGIS item id. Skips search.")
@click.option(
    "--saida",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Exact output file path. Defaults to /data/<server filename>.",
)
@click.option(
    "--diretorio",
    type=click.Path(file_okay=False, path_type=Path),
    default=DEFAULT_DEST_DIR,
    show_default=True,
    help="Directory used when --saida is not provided.",
)
@click.option("--listar", is_flag=True, help="Only print the selected ArcGIS item metadata.")
@click.option("--forca", is_flag=True, help="Overwrite an existing output file.")
def download_bdgd(
    query: str | None,
    ano: int | None,
    item_id: str | None,
    saida: Path | None,
    diretorio: Path,
    listar: bool,
    forca: bool,
) -> None:
    """Download the official ANEEL BDGD archive (.gdb.zip)."""
    item = _select_bdgd_item(query, ano, item_id)

    title = str(item.get("title") or item.get("name") or item.get("id"))
    fallback_filename = _safe_filename(f"{title}.gdb.zip", "bdgd.gdb.zip")
    destination = _resolve_output_path(saida, diretorio, fallback_filename)

    log.info("Selected BDGD item:")
    log.info("  id       : %s", item.get("id"))
    log.info("  title    : %s", title)
    log.info("  modified : %s", _format_arcgis_time(item.get("modified")))
    log.info("  created  : %s", _format_arcgis_time(item.get("created")))
    log.info("  size     : %s bytes", item.get("size") or "-")

    if listar:
        if not query and not item_id:
            log.info("No query provided; listed explicit item only.")
        return

    data_url = ANEEL_ARCGIS_ITEM_DATA_URL.format(item_id=item["id"])
    _download_stream(data_url, destination, force=forca)


@cli.command("continuidade")
@click.option(
    "--package-id",
    default=DEFAULT_CONTINUIDADE_PACKAGE,
    show_default=True,
    help="ANEEL CKAN package id for continuity indicators.",
)
@click.option("--resource-id", default=None, help="Exact CKAN resource id. Skips auto-selection.")
@click.option(
    "--tipo",
    type=click.Choice(["apurado", "limite", "compensacao", "atributos", "dominio"], case_sensitive=False),
    default="apurado",
    show_default=True,
    help="Which continuity CSV to download from the CKAN package.",
)
@click.option(
    "--saida",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Exact output file path. Defaults to /data/<resource filename>.",
)
@click.option(
    "--diretorio",
    type=click.Path(file_okay=False, path_type=Path),
    default=DEFAULT_DEST_DIR,
    show_default=True,
    help="Directory used when --saida is not provided.",
)
@click.option("--listar", is_flag=True, help="Only print the selected CKAN resource metadata.")
@click.option("--forca", is_flag=True, help="Overwrite an existing output file.")
def download_continuidade(
    package_id: str,
    resource_id: str | None,
    tipo: str,
    saida: Path | None,
    diretorio: Path,
    listar: bool,
    forca: bool,
) -> None:
    """Download the public ANEEL DEC/FEC continuity CSV."""
    selected, _csv_resources = _select_csv_resource(
        package_id,
        resource_id=resource_id,
        selector=lambda resource: _matches_continuity_type(resource, tipo.lower()),
        sort_key=_continuity_sort_key,
    )

    resource_name = str(selected.get("name") or selected.get("id") or "indicadores_continuidade.csv")
    url_path_name = Path(urlparse(str(selected.get("url") or "")).path).name
    fallback_filename = _safe_filename(url_path_name or resource_name, "indicadores_continuidade.csv")
    destination = _resolve_output_path(saida, diretorio, fallback_filename)

    log.info("Selected continuity resource:")
    log.info("  id            : %s", selected.get("id"))
    log.info("  name          : %s", resource_name)
    log.info("  last_modified : %s", selected.get("last_modified") or selected.get("created") or "-")
    log.info("  format        : %s", selected.get("format") or "-")
    log.info("  url           : %s", selected.get("url"))

    if listar:
        return

    _download_stream(str(selected["url"]), destination, force=forca)


@cli.command("indqual")
@click.option(
    "--package-id",
    default=DEFAULT_INDQUAL_PACKAGE,
    show_default=True,
    help="ANEEL CKAN package id for the IndQual Município linkage file.",
)
@click.option("--resource-id", default=None, help="Exact CKAN resource id. Skips auto-selection.")
@click.option(
    "--saida",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Exact output file path. Defaults to /data/<resource filename>.",
)
@click.option(
    "--diretorio",
    type=click.Path(file_okay=False, path_type=Path),
    default=DEFAULT_DEST_DIR,
    show_default=True,
    help="Directory used when --saida is not provided.",
)
@click.option("--listar", is_flag=True, help="Only print the selected CKAN resource metadata.")
@click.option("--forca", is_flag=True, help="Overwrite an existing output file.")
def download_indqual(
    package_id: str,
    resource_id: str | None,
    saida: Path | None,
    diretorio: Path,
    listar: bool,
    forca: bool,
) -> None:
    """Download the ANEEL IndQual Município linkage CSV."""
    selected, _csv_resources = _select_csv_resource(
        package_id,
        resource_id=resource_id,
        selector=lambda resource: "indqual-municipio" in str(resource.get("name") or "").lower()
        or "indqual-municipio" in str(resource.get("url") or "").lower(),
        sort_key=lambda resource: (
            str(resource.get("last_modified") or resource.get("created") or ""),
            str(resource.get("name") or ""),
        ),
    )

    resource_name = str(selected.get("name") or selected.get("id") or "indqual-municipio.csv")
    url_path_name = Path(urlparse(str(selected.get("url") or "")).path).name
    fallback_filename = _safe_filename(url_path_name or resource_name, "indqual-municipio.csv")
    destination = _resolve_output_path(saida, diretorio, fallback_filename)

    log.info("Selected IndQual resource:")
    log.info("  id            : %s", selected.get("id"))
    log.info("  name          : %s", resource_name)
    log.info("  last_modified : %s", selected.get("last_modified") or selected.get("created") or "-")
    log.info("  format        : %s", selected.get("format") or "-")
    log.info("  url           : %s", selected.get("url"))

    if listar:
        return

    _download_stream(str(selected["url"]), destination, force=forca)


def main() -> None:
    try:
        cli()
    except click.ClickException as exc:
        log.error("%s", exc.message)
        sys.exit(exc.exit_code)


if __name__ == "__main__":
    main()
