export type SupplierType = "produce" | "frozen" | "meat" | "northern" | "other";

export interface Supplier {
  id: string;
  name: string;
  type: SupplierType;
  temporary?: boolean;
}

export interface EvidenceItem {
  files: File[];
}

export interface SupplierResult {
  status: "pending" | "completed" | "no_goods";
  hasGoods: boolean | null;
  selections: Record<string, boolean | null>;
  evidence: Record<string, EvidenceItem>;
}
