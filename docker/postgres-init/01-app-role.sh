#!/bin/sh
# Creates the non-superuser role the application connects as. PostgreSQL superusers
# bypass row-level security, so tenant isolation requires the app to use this role.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE "${APP_DB_USER}" LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE "${APP_DB_NAME}" OWNER "${APP_DB_USER}";
SQL
