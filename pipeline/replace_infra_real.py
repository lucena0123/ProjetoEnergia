#!/usr/bin/env python3
"""
replace_infra_real.py — cutover da infraestrutura atual para base real

Remove os ativos e agregados derivados de uma distribuidora/UF antes da carga
oficial da BDGD.

Uso:
    python replace_infra_real.py \
        --uf CE \
        --distribuidora "Enel Ceará" \
        --limpar-derivados
"""

from __future__ import annotations

import os
import sys
import logging
from dataclasses import dataclass
import click
from dotenv import load_dotenv
from sqlalchemy import create_engine, text


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class DeleteRule:
    label: str
    where_sql: str


def _rules(limpar_derivados: bool) -> list[DeleteRule]:
    rules = [
        DeleteRule(
            "rede_mt",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "rede_bt",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "transformadores",
            "distribuidora = :dist "
            "AND municipio IN (SELECT nome FROM ibge_municipios WHERE uf = :uf)",
        ),
        DeleteRule(
            "religadores",
            "distribuidora = :dist "
            "AND municipio IN (SELECT nome FROM ibge_municipios WHERE uf = :uf)",
        ),
        DeleteRule(
            "subestacoes",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "alimentadores_at",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "rede_at",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "transformadores_at",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "religadores_at",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "chaves_at",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "subestacao_componentes",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "chaves",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "alimentadores",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "ucbt",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "ucmt",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "ucat",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "ug_at",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "ug_mt",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "ug_bt",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "chaves_bt",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "regulacao_reativos",
            "distribuidora = :dist AND uf = :uf",
        ),
        DeleteRule(
            "equipamentos_tecnicos",
            "distribuidora = :dist AND uf = :uf",
        ),
    ]

    if limpar_derivados:
        rules.extend(
            [
                DeleteRule("segmentos_mt_topologicos", "distribuidora = :dist AND uf = :uf"),
                DeleteRule("gaps_protecao", "distribuidora = :dist AND uf = :uf"),
                DeleteRule("mapa_risco", "distribuidora = :dist AND uf = :uf"),
                DeleteRule("historico_score", "distribuidora = :dist AND uf = :uf"),
                DeleteRule("alimentador_metricas", "distribuidora = :dist AND uf = :uf"),
            ]
        )

    return rules


def _count_rows(conn, table: str, where_sql: str, params: dict[str, str]) -> int:
    sql = text(f"SELECT COUNT(*) FROM {table} WHERE {where_sql}")
    return int(conn.execute(sql, params).scalar() or 0)


def _delete_rows(conn, table: str, where_sql: str, params: dict[str, str]) -> int:
    sql = text(f"DELETE FROM {table} WHERE {where_sql}")
    return int(conn.execute(sql, params).rowcount or 0)


@click.command()
@click.option("--uf", required=True, callback=lambda _ctx, _param, value: value.upper())
@click.option("--distribuidora", required=True, type=str)
@click.option(
    "--limpar-derivados/--preservar-derivados",
    default=True,
    show_default=True,
    help="Remove gaps_protecao, mapa_risco e historico_score do mesmo escopo antes do rebuild.",
)
@click.option("--dry-run", is_flag=True, help="Apenas mostra o que seria removido.")
@click.option(
    "--db-url",
    "db_url",
    default=None,
    envvar="DATABASE_URL",
    show_envvar=True,
    help="SQLAlchemy database URL.",
)
def main(
    uf: str,
    distribuidora: str,
    limpar_derivados: bool,
    dry_run: bool,
    db_url: str | None,
) -> None:
    load_dotenv()
    if db_url is None:
        db_url = os.getenv("DATABASE_URL")

    if not db_url:
        log.error("DATABASE_URL não definida. Use --db-url ou configure a variável de ambiente.")
        sys.exit(1)

    if len(uf) != 2:
        log.error("UF inválida: '%s'. Informe exatamente 2 letras.", uf)
        sys.exit(1)

    engine = create_engine(db_url, future=True, pool_pre_ping=True)
    params = {"uf": uf, "dist": distribuidora}
    rules = _rules(limpar_derivados)

    log.info("Preparando cutover da infraestrutura")
    log.info("  Distribuidora: %s", distribuidora)
    log.info("  UF          : %s", uf)
    log.info("  Derivados   : %s", "sim" if limpar_derivados else "não")
    log.info("  Dry-run     : %s", "sim" if dry_run else "não")

    if dry_run:
        with engine.connect() as conn:
            total = 0
            for rule in rules:
                count = _count_rows(conn, rule.label, rule.where_sql, params)
                total += count
                log.info("  %s: %d linha(s) seriam removidas.", rule.label, count)

            log.info("Dry-run concluído. Total planejado: %d linha(s).", total)
        return

    with engine.begin() as conn:
        total = 0
        for rule in rules:
            deleted = _delete_rows(conn, rule.label, rule.where_sql, params)
            total += deleted
            log.info("  %s: %d linha(s) removidas.", rule.label, deleted)

    log.info("Cutover concluído. Total removido: %d linha(s).", total)


if __name__ == "__main__":
    main()
