export type SupplierType = "produce" | "frozen" | "meat" | "northern" | "other";

export interface Supplier {
  id: string;
  name: string;
  type: SupplierType;
  temporary?: boolean;
}

export interface UploadedPhoto {
  file_token: string;
  file_name: string;
}

export interface EvidenceItem {
  files: File[];
  uploaded?: UploadedPhoto[];
}

export interface SupplierResult {
  status: "pending" | "completed" | "no_goods";
  hasGoods: boolean | null;
  selections: Record<string, boolean | null>;
  evidence: Record<string, EvidenceItem>;
  exceptionNote?: string;
  recordId?: string | null;
  operator?: string;
}

export type FormState = Record<string, SupplierResult>;

export interface OverviewMissingSupplier {
  name: string;
  type: SupplierType;
}

export interface OverviewDay {
  date: string;
  weekday: string;
  expected: number;
  submitted: number;
  missing: OverviewMissingSupplier[];
  temporaryCount: number;
}

export interface ReceivingPhoto {
  kind: string;
  file_token: string;
  file_name: string;
}

export interface ReceivingRecord {
  record_id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_type: SupplierType;
  date: string;
  status: "completed" | "no_goods";
  selections: Record<string, boolean | null>;
  exceptionNote: string;
  operator: string;
  photos: ReceivingPhoto[];
}
