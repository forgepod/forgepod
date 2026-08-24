FROM php:8.4-cli-alpine

WORKDIR /app
COPY server.php .

# No composer.json and no vendor directory. The point of this plugin is that a core with
# no plugin API of its own can be spoken to with a language's standard library alone.
ENTRYPOINT ["php", "server.php"]
