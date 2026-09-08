/**
 * A column added to a table that already shipped. SQLite has no `ADD COLUMN IF NOT EXISTS`
 * and a second `ALTER` raises "duplicate column name", so the table shape is read first and
 * the addition is skipped when it is already there. The definition text matches the `CREATE`
 * the same column has on a fresh file, which is what makes both files one table.
 */
export type ColumnAddition = {
  readonly table: string;
  readonly column: string;
  readonly definition: string;
};
