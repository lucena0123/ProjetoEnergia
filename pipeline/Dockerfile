FROM python:3.11-slim

WORKDIR /app

# Dependências de sistema necessárias para GeoPandas + psycopg2
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libgdal-dev \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Container fica vivo para uso via `docker compose exec pipeline`
CMD ["tail", "-f", "/dev/null"]
