export function buildTransformadorStatusSql(alias: string): string {
  return `
    CASE
      WHEN EXTRACT(YEAR FROM AGE(NOW(), ${alias}.data_implant)) > 25 THEN 'critico'
      WHEN EXTRACT(YEAR FROM AGE(NOW(), ${alias}.data_implant)) > 20 THEN 'atencao'
      ELSE 'ok'
    END
  `
}

export function buildTransformadorScoreSql(alias: string): string {
  return `
    ROUND(
      (
        LEAST(EXTRACT(YEAR FROM AGE(NOW(), ${alias}.data_implant)) / 30.0, 1.0) * 60
        + CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM religadores
              WHERE distribuidora = ${alias}.distribuidora
            ) THEN 40
            ELSE LEAST(
              (
                SELECT ST_Distance(${alias}.geom::geography, rel.geom::geography)
                FROM religadores rel
                WHERE rel.distribuidora = ${alias}.distribuidora
                ORDER BY ${alias}.geom <-> rel.geom
                LIMIT 1
              ) / 2000.0,
              1.0
            ) * 40
          END
      )::numeric,
      1
    )
  `
}
