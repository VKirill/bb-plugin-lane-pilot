export interface ForeignSqlSite {
  file: string;
  line: number;
  tables: string[];
}

export interface ForeignSql {
  count: number;
  sites: ForeignSqlSite[];
  byOwner: Record<string, number>;
}

export function foreignSql(root: string): ForeignSql;
