// Public example origin only. Host configuration is trusted; group text cannot set it.
export function parseWebsiteOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('invalid website origin');
  return url.origin;
}
export const websiteOrigin = parseWebsiteOrigin(process.env.DAFEIYU_WEBSITE_ORIGIN ?? 'https://example.com');
export const websiteURL = `${websiteOrigin}/`;
