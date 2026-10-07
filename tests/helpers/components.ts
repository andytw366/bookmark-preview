import type { Grid } from '@/shared/grid';

/** 測試用：`members` 在格子裡有幾個 4 連通的塊 */
export function components(grid: Grid, members: ReadonlySet<string>): number {
  const cells = new Set<number>();
  grid.cells.forEach((id, index) => {
    if (members.has(id)) {
      cells.add(index);
    }
  });
  const seen = new Set<number>();
  let count = 0;
  for (const start of cells) {
    if (seen.has(start)) {
      continue;
    }
    count += 1;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const cell = stack.pop() ?? 0;
      const col = cell % grid.columns;
      const next = [cell - grid.columns, cell + grid.columns, col > 0 ? cell - 1 : -1, col < grid.columns - 1 ? cell + 1 : -1];
      for (const n of next) {
        if (cells.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
  }
  return count;
}
