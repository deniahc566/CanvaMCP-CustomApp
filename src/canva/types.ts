// The subset of Canva Connect API shapes the tools read. Responses are passed through, so these only
// type the fields the code touches. Source: https://www.canva.dev/sources/connect/api/latest/api.yml

import type { Job } from './rest.js';

export interface Thumbnail {
  width: number;
  height: number;
  /** Signed URL, valid for 15 minutes. */
  url: string;
}

export interface DesignLinks {
  /** Temporary and only usable by the signed-in user. */
  edit_url: string;
  view_url: string;
}

export interface DesignSummary {
  id: string;
  title?: string;
  url?: string;
  thumbnail?: Thumbnail;
  urls: DesignLinks;
  created_at: number;
  updated_at: number;
  page_count?: number;
}

export interface Design extends DesignSummary {
  owner: { user_id: string; team_id: string };
  design_types?: string[];
}

export interface DesignPage {
  id?: string;
  page_number: number;
  dimensions?: { width: number; height: number };
  thumbnail?: Thumbnail;
  design_type?: string;
}

export interface Asset {
  type: 'image' | 'video';
  id: string;
  name: string;
  tags: string[];
  created_at: number;
  updated_at: number;
  thumbnail?: Thumbnail;
}

export interface ExportJob extends Job {
  urls?: string[];
}

export interface DesignResultJob extends Job {
  result?: { design: DesignSummary; type?: string; trial_information?: unknown };
}

export interface DesignImportJob extends Job {
  result?: { designs: DesignSummary[] };
}

export interface AssetUploadJob extends Job {
  asset?: Asset;
}

export interface ImageGenerationJob extends Job {
  result?: { image: { url: string; width: number; height: number; asset?: Asset } };
}

export interface ImageTransformationJob extends Job {
  result?: { asset: Asset };
}
