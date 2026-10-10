export type GeneratedFile = {
  /** Relative path inside the generated output directory. */
  path: string;
  content: string;
};

export type ConvertResponse = {
  success: true;
  sourceName: string;
  sourceUrl?: string;
  contractVersion?: string;
  sha256: string;
  files: GeneratedFile[];
  warnings: string[];
};

export type ArtifactEnvelope = ConvertResponse & {
  artifactId: string;
  expiresAt: string;
};
