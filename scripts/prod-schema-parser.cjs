const MAX_SCHEMA_BYTES = 262144;
const MAX_TABLES = 200;
const MAX_COLUMNS = 500;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function extractTableColumnBlock(schemaContent, tableName) {
  const declarationRegex = /export\s+const\s+\w+\s*=\s*sqliteTable\s*\(/g;
  let openingBrace = -1;
  while (declarationRegex.exec(schemaContent) !== null) {
    let cursor = declarationRegex.lastIndex;
    while (/\s/.test(schemaContent[cursor] ?? "")) cursor += 1;
    if (schemaContent[cursor] !== '"') continue;

    const nameStart = cursor + 1;
    const nameEnd = schemaContent.indexOf('"', nameStart);
    if (nameEnd === -1) continue;
    const declaredTableName = schemaContent.slice(nameStart, nameEnd);
    cursor = nameEnd + 1;
    while (/\s/.test(schemaContent[cursor] ?? "")) cursor += 1;
    if (schemaContent[cursor] !== ",") continue;
    cursor += 1;
    while (/\s/.test(schemaContent[cursor] ?? "")) cursor += 1;
    if (schemaContent[cursor] !== "{" || declaredTableName !== tableName) continue;

    openingBrace = cursor;
    break;
  }
  if (openingBrace === -1) return null;

  let depth = 0;
  for (let i = openingBrace; i < schemaContent.length; i += 1) {
    if (schemaContent[i] === "{") depth += 1;
    if (schemaContent[i] === "}") {
      depth -= 1;
      if (depth === 0) return schemaContent.slice(openingBrace + 1, i);
    }
  }
  return null;
}

function parseExpectedSchema(schemaContent) {
  const schemaBytes = Buffer.byteLength(schemaContent, "utf8");
  if (schemaBytes === 0 || schemaBytes > MAX_SCHEMA_BYTES) {
    throw new Error(`schema file must be between 1 and ${MAX_SCHEMA_BYTES} bytes.`);
  }

  const tableRegex = /export const \w+ = sqliteTable\s*\(\s*"([^"]+)"/g;
  const expectedTables = [];
  let match;
  while ((match = tableRegex.exec(schemaContent)) !== null) {
    const tableName = match[1];
    if (!IDENTIFIER.test(tableName) || expectedTables.includes(tableName)) {
      throw new Error(`invalid or duplicate SQL table identifier: ${JSON.stringify(tableName)}.`);
    }
    expectedTables.push(tableName);
    if (expectedTables.length > MAX_TABLES) {
      throw new Error(`schema exceeds the ${MAX_TABLES}-table limit.`);
    }
  }
  if (expectedTables.length === 0) throw new Error("schema contains no sqliteTable declarations.");

  let columnCount = 0;
  return expectedTables.map((tableName) => {
    const colBlock = extractTableColumnBlock(schemaContent, tableName);
    if (colBlock === null) {
      throw new Error(`could not parse the column declaration for table ${tableName}.`);
    }

    const colRegex = /\b\w+\s*:\s*\w+\s*\(\s*"([^"]+)"/g;
    const columns = [];
    let columnMatch;
    while ((columnMatch = colRegex.exec(colBlock)) !== null) {
      const columnName = columnMatch[1];
      if (!IDENTIFIER.test(columnName) || columns.includes(columnName)) {
        throw new Error(
          `invalid or duplicate SQL column identifier in ${tableName}: ${JSON.stringify(columnName)}.`,
        );
      }
      columns.push(columnName);
      columnCount += 1;
      if (columnCount > MAX_COLUMNS) {
        throw new Error(`schema exceeds the ${MAX_COLUMNS}-column limit.`);
      }
    }
    if (columns.length === 0) {
      throw new Error(`table ${tableName} contains no parseable column declarations.`);
    }
    return { tableName, columns };
  });
}

module.exports = { parseExpectedSchema };
