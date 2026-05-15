import { useCallback } from 'react';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useAuth } from './useAuth';
import { config } from '../config';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const PRESIGNED_URL_EXPIRY_SECONDS = 60 * 60; // 60 minutes

interface UseStorageReturn {
  uploadImage: (file: File) => Promise<string>;
  uploadMask: (blob: Blob) => Promise<string>;
  getPreSignedUrl: (key: string) => Promise<string>;
  downloadImage: (key: string) => Promise<void>;
}

function validateFile(file: File): void {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    throw new Error(
      `Invalid file type: ${file.type}. Only JPEG and PNG files are accepted.`
    );
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(
      `File size ${sizeMB} MB exceeds the 10 MB limit.`
    );
  }
}

function getExtensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    default:
      return 'png';
  }
}

async function getIdentityId(): Promise<string> {
  const session = await fetchAuthSession();
  if (!session.identityId) {
    throw new Error('Unable to retrieve identity ID from session');
  }
  return session.identityId;
}

export function useStorage(): UseStorageReturn {
  const { getCredentials } = useAuth();

  const getS3Client = useCallback(async (): Promise<S3Client> => {
    const credentials = await getCredentials();
    return new S3Client({
      region: config.region,
      credentials,
    });
  }, [getCredentials]);

  const uploadImage = useCallback(
    async (file: File): Promise<string> => {
      validateFile(file);

      const identityId = await getIdentityId();
      const ext = getExtensionFromMime(file.type);
      const uuid = crypto.randomUUID();
      const key = `users/${identityId}/uploads/${uuid}.${ext}`;

      const client = await getS3Client();
      const arrayBuffer = await file.arrayBuffer();

      await client.send(
        new PutObjectCommand({
          Bucket: config.imageBucketName,
          Key: key,
          Body: new Uint8Array(arrayBuffer),
          ContentType: file.type,
        })
      );

      return key;
    },
    [getS3Client]
  );

  const uploadMask = useCallback(
    async (blob: Blob): Promise<string> => {
      const identityId = await getIdentityId();
      const uuid = crypto.randomUUID();
      const key = `users/${identityId}/masks/${uuid}.png`;

      const client = await getS3Client();
      const arrayBuffer = await blob.arrayBuffer();

      await client.send(
        new PutObjectCommand({
          Bucket: config.imageBucketName,
          Key: key,
          Body: new Uint8Array(arrayBuffer),
          ContentType: 'image/png',
        })
      );

      return key;
    },
    [getS3Client]
  );

  const getPreSignedUrl = useCallback(
    async (key: string): Promise<string> => {
      const client = await getS3Client();
      const command = new GetObjectCommand({
        Bucket: config.imageBucketName,
        Key: key,
      });
      return getSignedUrl(client, command, {
        expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
      });
    },
    [getS3Client]
  );

  const downloadImage = useCallback(
    async (key: string): Promise<void> => {
      const url = await getPreSignedUrl(key);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const filename = key.split('/').pop() || 'image.png';
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(blobUrl);
    },
    [getPreSignedUrl]
  );

  return {
    uploadImage,
    uploadMask,
    getPreSignedUrl,
    downloadImage,
  };
}
