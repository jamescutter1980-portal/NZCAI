export type Rag = "green" | "amber" | "red";

export interface Substation {
  id: number;
  dnoId: string;
  dnoName: string;
  sourceRef: string;
  name: string | null;
  voltageKv: number | null;
  voltageGroup: string | null;
  lat: number | null;
  lng: number | null;
  demandHeadroomMva: number | null;
  generationHeadroomMva: number | null;
  demandRag: Rag | null;
  generationRag: Rag | null;
  constraintNote: string | null;
  ingestedAt: string;
}

export interface SubstationQuery {
  bbox?: [number, number, number, number];
  minGenerationHeadroomMva?: number;
  minVoltageKv?: number;
  maxVoltageKv?: number;
  dnoIds?: string[];
  limit: number;
}

export interface IngestStatus {
  dnoId: string;
  dnoName: string;
  kind: "heatmap" | "ecr";
  dataset: string;
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt: string | null;
  rowsWritten: number;
  message: string | null;
}
