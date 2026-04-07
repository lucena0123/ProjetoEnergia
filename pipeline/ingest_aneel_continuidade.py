#!/usr/bin/env python3
"""
ingest_aneel_continuidade.py — GridRisk pipeline: ANEEL real DEC/FEC indicators

Downloads and ingests real DEC/FEC continuity indicators from ANEEL's open data
portal into the indicadores_continuidade table.

Data sources (public ANEEL open data):
  Indicators: https://dadosabertos.aneel.gov.br/.../indicadores-continuidade-coletivos-2020-2029.csv
  Attributes: https://dadosabertos.aneel.gov.br/.../indicadores-continuidade-coletivos-atributos.csv

Usage:
    python ingest_aneel_continuidade.py --uf AL --uf CE
    python ingest_aneel_continuidade.py --uf ALL
    python ingest_aneel_continuidade.py --uf AL --ano-inicio 2022 --ano-fim 2023
    python ingest_aneel_continuidade.py --uf AL --force
"""

import os
import sys
import logging
from pathlib import Path
from typing import Optional

import click
import pandas as pd
import requests
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ANEEL_INDICADORES_URL = (
    "https://dadosabertos.aneel.gov.br/dataset/d5f0712e-62f6-4736-8dff-9991f10758a7"
    "/resource/4493985c-baea-429c-9df5-3030422c71d7/download/"
    "indicadores-continuidade-coletivos-2020-2029.csv"
)
ANEEL_ATRIBUTOS_URL = (
    "https://dadosabertos.aneel.gov.br/dataset/d5f0712e-62f6-4736-8dff-9991f10758a7"
    "/resource/3c780aca-38cf-406d-9d45-f07a9216eef2/download/"
    "indicadores-continuidade-coletivos-atributos.csv"
)

CACHE_DIR = Path(__file__).parent / ".cache_aneel"
CACHE_INDICADORES = CACHE_DIR / "indicadores-continuidade-coletivos-2020-2029.csv"
CACHE_ATRIBUTOS = CACHE_DIR / "indicadores-continuidade-coletivos-atributos.csv"

TARGET_TABLE = "indicadores_continuidade"

ALL_UFS = [
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
    "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
    "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def _download_file(url: str, dest: Path, force: bool = False) -> Path:
    """Download a file to dest, skipping if it already exists and force=False."""
    if dest.exists() and not force:
        log.info("  Cache hit: %s (use --force to re-download)", dest.name)
        return dest

    log.info("  Baixando %s ...", url)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    resp = requests.get(url, timeout=300, stream=True)
    resp.raise_for_status()
    total = 0
    with open(dest, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 256):
            f.write(chunk)
            total += len(chunk)
    log.info("  Salvo em %s (%.1f MB)", dest, total / 1_048_576)
    return dest


def _read_csv_with_encoding(path: Path) -> pd.DataFrame:
    """Try to read a CSV with multiple encodings (utf-8-sig, latin-1, utf-8)."""
    for enc in ("utf-8-sig", "latin-1", "utf-8"):
        try:
            df = pd.read_csv(path, sep=";", encoding=enc, dtype=str, low_memory=False)
            log.info("  Lido com encoding '%s': %d linhas, %d colunas", enc, len(df), len(df.columns))
            return df
        except UnicodeDecodeError:
            log.debug("  Encoding '%s' falhou, tentando próximo...", enc)
    raise RuntimeError(f"Não foi possível ler {path} com nenhum encoding suportado.")


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------

def _load_atributos(path: Path, ufs: list[str]) -> pd.DataFrame:
    """Load attributes file and filter by UF."""
    df = _read_csv_with_encoding(path)

    # Strip whitespace from all string columns
    str_cols = df.select_dtypes("object").columns
    df[str_cols] = df[str_cols].apply(lambda s: s.str.strip())

    # Find the relevant columns (case-insensitive)
    col_map = {c.strip(): c for c in df.columns}
    # Map known column names
    ide_col = next((c for c in df.columns if "IdeConj" in c or "ideconj" in c.lower()), None)
    uf_col = next((c for c in df.columns if c.strip() in ("SigUF", "SigUf") or "siguf" == c.strip().lower()), None)
    mun_col = next((c for c in df.columns if "NomMunicipio" in c or "nommunicipio" in c.lower()), None)
    ag_col = next((c for c in df.columns if "SigAgente" in c or "sigagente" in c.lower()), None)

    # Fallback: try partial matches
    if ide_col is None:
        ide_col = next((c for c in df.columns if "conj" in c.lower()), None)
    if uf_col is None:
        uf_col = next((c for c in df.columns if "uf" in c.lower()), None)
    if mun_col is None:
        mun_col = next((c for c in df.columns if "munic" in c.lower()), None)
    if ag_col is None:
        ag_col = next((c for c in df.columns if "agent" in c.lower()), None)

    if ide_col is None or uf_col is None:
        log.error("Colunas essenciais não encontradas no arquivo de atributos. Colunas: %s", list(df.columns))
        raise ValueError("Arquivo de atributos não tem as colunas esperadas.")

    log.info("  Atributos — colunas mapeadas: ide=%s, uf=%s, mun=%s, agente=%s",
             ide_col, uf_col, mun_col, ag_col)

    # Re-strip the key column
    df[ide_col] = df[ide_col].str.strip()
    df[uf_col] = df[uf_col].str.strip().str.upper()

    # Filter by UF
    df_filt = df[df[uf_col].isin(ufs)].copy()
    log.info("  Atributos: %d conjuntos elétricos para UFs %s", len(df_filt), ufs)

    result = pd.DataFrame({
        "ide_conj": df_filt[ide_col].str.strip(),
        "municipio": df_filt[mun_col].str.strip() if mun_col else None,
        "uf": df_filt[uf_col].str.strip().str.upper(),
        "distribuidora": df_filt[ag_col].str.strip() if ag_col else None,
    })
    return result


def _load_indicadores(
    path: Path,
    conj_ids: set,
    ano_inicio: Optional[int],
    ano_fim: Optional[int],
) -> pd.DataFrame:
    """Load indicators file filtered by conjunction IDs and date range."""
    log.info("  Carregando arquivo de indicadores (pode demorar)...")
    df = _read_csv_with_encoding(path)

    # Strip whitespace from string cols
    str_cols = df.select_dtypes("object").columns
    df[str_cols] = df[str_cols].apply(lambda s: s.str.strip())

    # Find columns
    ide_col = next((c for c in df.columns if "IdeConj" in c or "ideconj" in c.lower()), None)
    ag_col = next((c for c in df.columns if "SigAgente" in c or "sigagente" in c.lower()), None)
    anomes_col = next((c for c in df.columns if "AnoMes" in c or "anomes" in c.lower()), None)
    sig_col = next((c for c in df.columns if "SigIndicador" in c or "sigindicador" in c.lower()), None)
    val_ap_col = next((c for c in df.columns if "ValApurado" in c or "valapurado" in c.lower()), None)
    val_lim_col = next((c for c in df.columns if "ValLimite" in c or "vallimite" in c.lower()), None)

    # Fallbacks
    if ide_col is None:
        ide_col = next((c for c in df.columns if "conj" in c.lower()), None)
    if anomes_col is None:
        anomes_col = next((c for c in df.columns if "referencia" in c.lower() or "periodo" in c.lower()), None)
    if sig_col is None:
        sig_col = next((c for c in df.columns if "indicador" in c.lower()), None)
    if val_ap_col is None:
        val_ap_col = next((c for c in df.columns if "apurado" in c.lower()), None)
    if val_lim_col is None:
        val_lim_col = next((c for c in df.columns if "limite" in c.lower()), None)

    if ide_col is None or sig_col is None or val_ap_col is None:
        log.error("Colunas essenciais não encontradas no arquivo de indicadores. Colunas: %s", list(df.columns))
        raise ValueError("Arquivo de indicadores não tem as colunas esperadas.")

    log.info("  Indicadores — colunas: ide=%s, anomes=%s, sig=%s, val_ap=%s, val_lim=%s",
             ide_col, anomes_col, sig_col, val_ap_col, val_lim_col)

    # Filter by conjunction IDs
    df[ide_col] = df[ide_col].str.strip()
    df_filt = df[df[ide_col].isin(conj_ids)].copy()
    log.info("  Indicadores: %d linhas após filtro por conjuntos elétricos", len(df_filt))

    if df_filt.empty:
        return pd.DataFrame()

    # Only keep DEC and FEC (not DEC_EXT, DEC_INT, etc.)
    df_filt = df_filt[df_filt[sig_col].isin(["DEC", "FEC"])].copy()
    log.info("  Indicadores: %d linhas com SigIndicador in [DEC, FEC]", len(df_filt))

    # Parse AnoMesReferencia → ano, mes
    if anomes_col:
        anomes = df_filt[anomes_col].astype(str).str.strip()
        df_filt["ano"] = anomes.str[:4].pipe(pd.to_numeric, errors="coerce").astype("Int64")
        df_filt["mes"] = anomes.str[4:6].pipe(pd.to_numeric, errors="coerce").astype("Int64")
    else:
        df_filt["ano"] = pd.NA
        df_filt["mes"] = pd.NA

    # Apply date range filter
    if ano_inicio is not None:
        df_filt = df_filt[df_filt["ano"] >= ano_inicio]
    if ano_fim is not None:
        df_filt = df_filt[df_filt["ano"] <= ano_fim]
    log.info("  Indicadores: %d linhas após filtro de datas", len(df_filt))

    # Convert ValApurado and ValLimite (comma decimal separator)
    df_filt["val_apurado"] = (
        df_filt[val_ap_col].astype(str).str.strip()
        .str.replace(",", ".", regex=False)
        .pipe(pd.to_numeric, errors="coerce")
    )
    if val_lim_col:
        df_filt["val_limite"] = (
            df_filt[val_lim_col].astype(str).str.strip()
            .str.replace(",", ".", regex=False)
            .pipe(pd.to_numeric, errors="coerce")
        )
    else:
        df_filt["val_limite"] = None

    result = pd.DataFrame({
        "ide_conj": df_filt[ide_col].str.strip(),
        "sig_indicador": df_filt[sig_col].str.strip(),
        "ano": df_filt["ano"],
        "mes": df_filt["mes"],
        "val_apurado": df_filt["val_apurado"],
        "val_limite": df_filt["val_limite"],
    })
    return result


def _pivot_and_aggregate(
    atributos_df: pd.DataFrame,
    indicadores_df: pd.DataFrame,
) -> pd.DataFrame:
    """
    Merge indicators with attributes, aggregate to municipality level,
    pivot DEC/FEC into one row per (distribuidora, municipio, uf, ano, mes).
    """
    # Merge to get distribuidora, municipio, uf per indicator row
    merged = indicadores_df.merge(atributos_df, on="ide_conj", how="inner")
    log.info("  Após merge atributos×indicadores: %d linhas", len(merged))

    group_cols = ["distribuidora", "municipio", "uf", "ano", "mes", "sig_indicador"]
    agg = (
        merged.groupby(group_cols, as_index=False)
        .agg(
            val_apurado=("val_apurado", "mean"),
            val_limite=("val_limite", "mean"),
        )
    )

    # Pivot DEC and FEC into separate columns
    dec_df = agg[agg["sig_indicador"] == "DEC"].copy()
    fec_df = agg[agg["sig_indicador"] == "FEC"].copy()

    key_cols = ["distribuidora", "municipio", "uf", "ano", "mes"]

    dec_df = dec_df[key_cols + ["val_apurado", "val_limite"]].rename(columns={
        "val_apurado": "dec_apurado",
        "val_limite": "dec_limite",
    })
    fec_df = fec_df[key_cols + ["val_apurado", "val_limite"]].rename(columns={
        "val_apurado": "fec_apurado",
        "val_limite": "fec_limite",
    })

    final = dec_df.merge(fec_df, on=key_cols, how="outer")
    log.info("  Após pivot DEC/FEC: %d linhas", len(final))

    return final


def _clean_data(df: pd.DataFrame) -> pd.DataFrame:
    """Apply data cleaning: strip whitespace, title-case municipio, upper UF, drop nulls."""
    # Strip whitespace on all string columns
    str_cols = df.select_dtypes("object").columns
    df[str_cols] = df[str_cols].apply(lambda s: s.str.strip())

    # Title-case municipality names
    if "municipio" in df.columns:
        df["municipio"] = df["municipio"].str.title()

    # Upper-case UF
    if "uf" in df.columns:
        df["uf"] = df["uf"].str.upper()

    # Drop rows with null dec_apurado OR null fec_apurado
    before = len(df)
    df = df.dropna(subset=["dec_apurado", "fec_apurado"])
    dropped = before - len(df)
    if dropped:
        log.info("  %d linhas removidas por dec_apurado ou fec_apurado nulos", dropped)

    return df


def _insert_into_db(df: pd.DataFrame, engine) -> None:
    """Delete existing rows for each distribuidora found, then insert new data."""
    distribuidoras = df["distribuidora"].unique().tolist()
    log.info("  Distribuidoras encontradas: %s", distribuidoras)

    with engine.begin() as conn:
        for dist in distribuidoras:
            deleted = conn.execute(
                text("DELETE FROM indicadores_continuidade WHERE distribuidora = :d"),
                {"d": dist},
            ).rowcount
            if deleted:
                log.info("  Removidas %d linhas existentes para '%s'", deleted, dist)

    df.to_sql(
        TARGET_TABLE,
        engine,
        if_exists="append",
        index=False,
        chunksize=5000,
        method="multi",
    )
    log.info("  %d registros inseridos em '%s'", len(df), TARGET_TABLE)


def _log_stats(df: pd.DataFrame) -> None:
    """Log summary statistics."""
    log.info("  === Estatísticas ===")
    log.info("  Total de registros: %d", len(df))

    # Total municipalities per UF
    mun_per_uf = df.groupby("uf")["municipio"].nunique()
    for uf_name, count in mun_per_uf.items():
        log.info("  Municípios em %s: %d", uf_name, count)

    # Top 5 highest DEC municipalities
    top_dec = (
        df.groupby(["municipio", "uf"])["dec_apurado"]
        .mean()
        .nlargest(5)
        .reset_index()
    )
    log.info("  Top 5 municípios com maior DEC médio:")
    for i, row in top_dec.iterrows():
        log.info("    %d. %-35s (%s)  DEC médio %.2fh",
                 i + 1, row["municipio"], row["uf"], row["dec_apurado"])


# ---------------------------------------------------------------------------
# Programmatic entry point (for import from seed_demo.py)
# ---------------------------------------------------------------------------

def ingest_for_seed(
    uf: str,
    engine,
    ano_inicio: int = 2022,
    ano_fim: int = 2023,
    distribuidora_override: Optional[str] = None,
) -> pd.DataFrame:
    """
    Programmatic entry point: download and ingest ANEEL DEC/FEC data for a given UF.

    Can be called directly from seed_demo.py without going through the CLI.
    Returns the final DataFrame that was inserted.

    Raises an exception on failure (network errors, missing data, etc.),
    which the caller can catch to fall back to synthetic data.
    """
    ufs = ALL_UFS if uf.upper() == "ALL" else [u.strip().upper() for u in uf.split(",")]

    log.info("Baixando dados reais ANEEL para UF(s): %s", ufs)

    # Download with cache
    atrib_path = _download_file(ANEEL_ATRIBUTOS_URL, CACHE_ATRIBUTOS, force=False)
    indic_path = _download_file(ANEEL_INDICADORES_URL, CACHE_INDICADORES, force=False)

    # Load and filter attributes
    atributos_df = _load_atributos(atrib_path, ufs)
    if atributos_df.empty:
        raise ValueError(f"Nenhum conjunto elétrico encontrado para UFs {ufs}")

    conj_ids = set(atributos_df["ide_conj"].tolist())
    log.info("  %d conjuntos elétricos encontrados", len(conj_ids))

    # Load indicators
    indicadores_df = _load_indicadores(indic_path, conj_ids, ano_inicio, ano_fim)
    if indicadores_df.empty:
        raise ValueError(f"Nenhum indicador DEC/FEC encontrado para os conjuntos das UFs {ufs}")

    # Pivot and aggregate
    final_df = _pivot_and_aggregate(atributos_df, indicadores_df)

    # Clean
    final_df = _clean_data(final_df)

    if final_df.empty:
        raise ValueError("DataFrame final vazio após limpeza.")

    if distribuidora_override:
        final_df["distribuidora"] = distribuidora_override

    # Insert
    _insert_into_db(final_df, engine)

    # Log stats
    _log_stats(final_df)

    return final_df


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option(
    "--uf",
    multiple=True,
    required=True,
    help='Estado(s) a processar (ex: --uf AL --uf CE) ou --uf ALL para todos.',
)
@click.option(
    "--ano-inicio",
    "ano_inicio",
    default=None,
    type=int,
    help="Ano inicial do filtro (inclusive). Ex: 2022",
)
@click.option(
    "--ano-fim",
    "ano_fim",
    default=None,
    type=int,
    help="Ano final do filtro (inclusive). Ex: 2023",
)
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Força re-download dos arquivos mesmo que já existam no cache.",
)
@click.option(
    "--db-url",
    "db_url",
    default=None,
    envvar="DATABASE_URL",
    show_envvar=True,
    help="SQLAlchemy database URL. Usa DATABASE_URL se não informado.",
)
def main(
    uf: tuple,
    ano_inicio: Optional[int],
    ano_fim: Optional[int],
    force: bool,
    db_url: Optional[str],
) -> None:
    """Baixa e ingere indicadores DEC/FEC reais da ANEEL no banco GridRisk."""

    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL não definida. Use --db-url ou defina a variável de ambiente.")
        sys.exit(1)

    # Resolve UF list
    ufs_input = list(uf)
    if len(ufs_input) == 1 and ufs_input[0].upper() == "ALL":
        ufs = ALL_UFS
    else:
        ufs = [u.strip().upper() for u in ufs_input]

    log.info("=" * 60)
    log.info("ANEEL DEC/FEC Ingest — UFs: %s", ufs)
    log.info("=" * 60)

    # Step 1: Download (with cache)
    log.info("[1/4] Baixando arquivos da ANEEL...")
    try:
        atrib_path = _download_file(ANEEL_ATRIBUTOS_URL, CACHE_ATRIBUTOS, force=force)
        indic_path = _download_file(ANEEL_INDICADORES_URL, CACHE_INDICADORES, force=force)
    except Exception as exc:
        log.error("Falha ao baixar arquivos: %s", exc)
        sys.exit(1)

    # Step 2: Load attributes
    log.info("[2/4] Carregando arquivo de atributos...")
    try:
        atributos_df = _load_atributos(atrib_path, ufs)
    except Exception as exc:
        log.error("Falha ao carregar atributos: %s", exc)
        sys.exit(1)

    if atributos_df.empty:
        log.warning("Nenhum conjunto elétrico encontrado para UFs %s. Encerrando.", ufs)
        sys.exit(0)

    conj_ids = set(atributos_df["ide_conj"].tolist())
    log.info("  %d conjuntos elétricos filtrados.", len(conj_ids))

    # Step 3: Load indicators
    log.info("[3/4] Carregando arquivo de indicadores...")
    try:
        indicadores_df = _load_indicadores(indic_path, conj_ids, ano_inicio, ano_fim)
    except Exception as exc:
        log.error("Falha ao carregar indicadores: %s", exc)
        sys.exit(1)

    if indicadores_df.empty:
        log.warning("Nenhum indicador encontrado após filtros. Encerrando.")
        sys.exit(0)

    # Pivot and aggregate
    final_df = _pivot_and_aggregate(atributos_df, indicadores_df)

    # Clean
    final_df = _clean_data(final_df)

    if final_df.empty:
        log.warning("DataFrame final vazio após limpeza. Encerrando.")
        sys.exit(0)

    # Step 4: Insert into DB
    log.info("[4/4] Inserindo no banco de dados...")
    try:
        engine = create_engine(db_url, pool_pre_ping=True)
        _insert_into_db(final_df, engine)
    except Exception as exc:
        log.error("Falha ao inserir no banco: %s", exc)
        sys.exit(1)

    # Log stats
    _log_stats(final_df)

    log.info("=" * 60)
    log.info("Ingestão ANEEL concluída com sucesso.")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
