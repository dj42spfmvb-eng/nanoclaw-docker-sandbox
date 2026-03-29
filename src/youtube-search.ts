import YouTube from 'youtube-sr';
import { logger } from './logger.js';

export interface YouTubeResult {
  title: string;
  url: string;
  duration: string;
  channel: string;
  views: string;
  uploadedAt: string;
  thumbnail: string;
}

export async function searchYouTube(
  query: string,
  maxResults = 5,
): Promise<{ results: YouTubeResult[] } | { error: string }> {
  try {
    const videos = await YouTube.default.search(query, {
      limit: maxResults,
      type: 'video',
    });

    const results: YouTubeResult[] = videos.map(
      (v: InstanceType<typeof YouTube.Video>) => ({
        title: v.title ?? 'Untitled',
        url: v.url ?? '',
        duration: v.durationFormatted ?? 'unknown',
        channel: v.channel?.name ?? 'Unknown',
        views: v.views ? v.views.toLocaleString() : 'unknown',
        uploadedAt: v.uploadedAt ?? 'unknown',
        thumbnail: v.thumbnail?.url ?? '',
      }),
    );

    logger.info({ query, count: results.length }, 'YouTube search completed');
    return { results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ query, err: msg }, 'YouTube search failed');
    return { error: msg };
  }
}
