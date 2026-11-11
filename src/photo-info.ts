export interface PhotoExif {
  make?: string;
  model?: string;
  lensModel?: string;
  description?: string;
  originalDateTime?: string;
  originalOffset?: string;
  exposureTime?: string;
  fNumber?: number;
  focalLength?: number;
  iso?: number;
  latitude?: number;
  longitude?: number;
  orientation?: string;
  warning?: string;
}
export interface PhotoMetadataData {
  id: string;
  version: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  isTrashed: boolean;
  extracted: boolean;
  source: PhotoExif;
  timeSource: 'submitted' | 'file' | 'exif' | 'manual';
  description: string | null;
  timeZone: string | null;
  latitude: number | null;
  longitude: number | null;
  make: string | null;
  model: string | null;
  lensModel: string | null;
  fNumber: number | null;
  exposureTime: string | null;
  focalLength: number | null;
  iso: number | null;
  rating: number | null;
}
