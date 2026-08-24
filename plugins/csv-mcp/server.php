<?php

/**
 * CSV help over MCP, written against the wire rather than against an SDK.
 *
 * The other plugins that ship use the Python MCP library. This one exists to show that
 * nothing requires it: MCP over stdio is JSON-RPC 2.0, one object per line, no framing
 * headers, and a language's standard library is enough to answer. No composer.json, no
 * vendor directory, no dependency of any kind.
 *
 * The four messages that matter are initialize, the notifications/initialized that
 * follows it and wants no answer, tools/list and tools/call.
 */

// CLI PHP writes warnings and notices to stdout, and stdout is the protocol. One
// deprecation from a future release would corrupt the stream and read as a client bug.
ini_set('display_errors', 'stderr');

const SERVER_NAME = 'csv-mcp';
const SERVER_VERSION = '0.1.0';
const FALLBACK_PROTOCOL = '2025-06-18';

/** Declared per tool, which is what makes the core receive data instead of a string to re-parse. */
function tools(): array
{
    $csv = ['type' => 'string', 'description' => 'The CSV text itself, not a path to it.'];
    $hasHeader = [
        'type' => 'boolean',
        'description' => 'Whether the first row names the columns. Defaults to true.',
    ];

    return [
        [
            'name' => 'csv_to_markdown',
            'description' => 'Render CSV as a markdown table.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => ['csv' => $csv, 'has_header' => $hasHeader],
                'required' => ['csv'],
            ],
            'outputSchema' => [
                'type' => 'object',
                'properties' => [
                    'markdown' => ['type' => 'string'],
                    'rows' => ['type' => 'integer'],
                    'columns' => ['type' => 'integer'],
                ],
                'required' => ['markdown', 'rows', 'columns'],
            ],
        ],
        [
            'name' => 'csv_column_stats',
            'description' => 'Count, sum, smallest, largest and mean of one numeric column.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'csv' => $csv,
                    'column' => [
                        'type' => 'string',
                        'description' => 'A column name when the CSV has a header, '
                            . 'otherwise a zero-based index.',
                    ],
                    'has_header' => $hasHeader,
                ],
                'required' => ['csv', 'column'],
            ],
            'outputSchema' => [
                'type' => 'object',
                'properties' => [
                    'count' => ['type' => 'integer'],
                    'sum' => ['type' => 'number'],
                    'min' => ['type' => 'number'],
                    'max' => ['type' => 'number'],
                    'mean' => ['type' => 'number'],
                ],
                'required' => ['count', 'sum', 'min', 'max', 'mean'],
            ],
        ],
    ];
}

/**
 * Parsed through a stream rather than by splitting on newlines, so a quoted field
 * containing a line break stays one field.
 */
function parseCsv(string $csv): array
{
    $handle = fopen('php://memory', 'r+');
    fwrite($handle, $csv);
    rewind($handle);

    $rows = [];
    while (($row = fgetcsv($handle, 0, ',', '"', '')) !== false) {
        // fgetcsv reports a blank line as one null field. A trailing newline is normal
        // and should not become an empty row.
        if ($row === [null]) {
            continue;
        }
        $rows[] = array_map(fn($cell) => trim((string) $cell), $row);
    }
    fclose($handle);

    if ($rows === []) {
        throw new InvalidArgumentException('the csv is empty');
    }
    return $rows;
}

function csvToMarkdown(array $arguments): array
{
    $rows = parseCsv($arguments['csv'] ?? '');
    $hasHeader = $arguments['has_header'] ?? true;
    $width = max(array_map('count', $rows));

    // A pipe ends a cell and a line break ends the row, so both have to go before this
    // becomes a table rather than after. Markdown has no way to write a line break inside
    // a cell, and <br> is what renderers accept in its place.
    $cell = fn($value) => str_replace(
        ['|', "\r\n", "\n", "\r"],
        ['\\|', '<br>', '<br>', '<br>'],
        $value,
    );
    $render = fn(array $row) => '| '
        . implode(' | ', array_map($cell, array_pad($row, $width, '')))
        . ' |';

    $header = $hasHeader ? array_shift($rows) : array_map(
        fn($index) => 'Column ' . ($index + 1),
        range(0, $width - 1),
    );

    $lines = [$render($header), '| ' . implode(' | ', array_fill(0, $width, '---')) . ' |'];
    foreach ($rows as $row) {
        $lines[] = $render($row);
    }

    return [
        'markdown' => implode("\n", $lines),
        'rows' => count($rows),
        'columns' => $width,
    ];
}

function csvColumnStats(array $arguments): array
{
    $rows = parseCsv($arguments['csv'] ?? '');
    $hasHeader = $arguments['has_header'] ?? true;
    $column = (string) ($arguments['column'] ?? '');

    if ($hasHeader) {
        $header = array_shift($rows);
        $index = array_search($column, $header, true);
        if ($index === false) {
            throw new InvalidArgumentException(
                sprintf('no column named %s. The header is: %s', $column, implode(', ', $header)),
            );
        }
    } else {
        if (!ctype_digit($column)) {
            throw new InvalidArgumentException(
                'without a header, column must be a zero-based index',
            );
        }
        $index = (int) $column;
    }

    $values = [];
    foreach ($rows as $number => $row) {
        $cell = $row[$index] ?? '';
        if ($cell === '') {
            continue;
        }
        // Refused rather than skipped. A column with one stray word in it produces a sum
        // that looks right and is not, and nobody checks a number that arrived.
        if (!is_numeric($cell)) {
            throw new InvalidArgumentException(
                sprintf('row %d of column %s is not a number: %s', $number + 1, $column, $cell),
            );
        }
        $values[] = (float) $cell;
    }

    if ($values === []) {
        throw new InvalidArgumentException(sprintf('column %s holds no numbers', $column));
    }

    return [
        'count' => count($values),
        'sum' => array_sum($values),
        'min' => min($values),
        'max' => max($values),
        'mean' => array_sum($values) / count($values),
    ];
}

function callTool(array $params): array
{
    $name = $params['name'] ?? '';
    $arguments = $params['arguments'] ?? [];

    try {
        $structured = match ($name) {
            'csv_to_markdown' => csvToMarkdown($arguments),
            'csv_column_stats' => csvColumnStats($arguments),
            default => throw new InvalidArgumentException("no such tool: {$name}"),
        };
    } catch (Throwable $failure) {
        // A tool that refuses its input is a result the model can read and correct, not a
        // protocol error that kills the call.
        return [
            'content' => [['type' => 'text', 'text' => $failure->getMessage()]],
            'isError' => true,
        ];
    }

    return [
        // Both, because a client that ignores structured output still has to see something.
        'content' => [['type' => 'text', 'text' => json_encode($structured)]],
        'structuredContent' => $structured,
        'isError' => false,
    ];
}

function handle(array $message): ?array
{
    $method = $message['method'] ?? '';
    $params = $message['params'] ?? [];

    return match ($method) {
        'initialize' => [
            // Echoed back. The client offers what it speaks, and this server has no
            // version-specific behaviour to protect.
            'protocolVersion' => $params['protocolVersion'] ?? FALLBACK_PROTOCOL,
            'capabilities' => ['tools' => new stdClass()],
            'serverInfo' => ['name' => SERVER_NAME, 'version' => SERVER_VERSION],
        ],
        'tools/list' => ['tools' => tools()],
        'tools/call' => callTool($params),
        'ping' => new stdClass(),
        default => null,
    };
}

while (($line = fgets(STDIN)) !== false) {
    $line = trim($line);
    if ($line === '') {
        continue;
    }

    $message = json_decode($line, true);
    // A message with no id is a notification, and answering one is a protocol error.
    $id = is_array($message) ? ($message['id'] ?? null) : null;

    if (!is_array($message)) {
        if ($id === null) {
            continue;
        }
        $reply = [
            'jsonrpc' => '2.0',
            'id' => $id,
            'error' => ['code' => -32700, 'message' => 'parse error'],
        ];
    } else {
        $result = handle($message);
        if ($id === null) {
            continue;
        }
        $reply = $result === null
            ? [
                'jsonrpc' => '2.0',
                'id' => $id,
                'error' => [
                    'code' => -32601,
                    'message' => 'method not found: ' . ($message['method'] ?? ''),
                ],
            ]
            : ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    }

    fwrite(STDOUT, json_encode($reply, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
}
