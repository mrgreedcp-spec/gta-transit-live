import type { Metadata } from 'next';
import { BRAND, Locale, PagePath, PAGE_PATHS, REVIEW_DATE, pageMeta, pageUrl, tr } from './content';

const configuredOrigin = process.env.SITE_URL || 'https://gta-transit-live.onrender.com';
const parsedOrigin = new URL(configuredOrigin);
if (!['https:', 'http:'].includes(parsedOrigin.protocol) || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) {
  throw new Error('SITE_URL must be the public site origin without a path, query or fragment.');
}
export const SITE_URL = parsedOrigin.origin;
export const absoluteUrl = (path: string, locale: Locale = 'en') => `${SITE_URL}${pageUrl(path, locale)}`;

export function metadataFor(path: PagePath, locale: Locale): Metadata {
  const title = `${tr(pageMeta[path].title, locale)} | ${BRAND}`;
  const description = tr(pageMeta[path].description, locale);
  return {
    metadataBase: new URL(SITE_URL), title, description,
    applicationName: BRAND,
    alternates: {
      canonical: absoluteUrl(path, locale),
      languages: { 'en-CA': absoluteUrl(path), 'zh-Hans': absoluteUrl(path, 'zh'), 'x-default': absoluteUrl(path) },
    },
    robots: { index: true, follow: true },
    openGraph: {
      type: 'website', title, description, siteName: BRAND,
      url: absoluteUrl(path, locale), locale: locale === 'zh' ? 'zh_CN' : 'en_CA',
      alternateLocale: locale === 'zh' ? ['en_CA'] : ['zh_CN'],
    },
    twitter: { card: 'summary', title, description },
    icons: { icon: '/guide-icon.svg' },
    ...(process.env.GOOGLE_SITE_VERIFICATION ? { verification: { google: process.env.GOOGLE_SITE_VERIFICATION } } : {}),
  };
}

export function structuredData(path: PagePath, locale: Locale) {
  const home = absoluteUrl('', locale);
  const url = absoluteUrl(path, locale);
  const crumbs: { name: string; item: string }[] = [{ name: locale === 'zh' ? '首页' : 'Home', item: home }];
  if (path.includes('/')) {
    const parent = path.split('/')[0] as PagePath;
    crumbs.push({ name: tr(pageMeta[parent].title, locale), item: absoluteUrl(parent, locale) });
  }
  if (path) crumbs.push({ name: tr(pageMeta[path].title, locale), item: url });
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, name: BRAND, url: SITE_URL, inLanguage: ['en-CA', 'zh-Hans'] },
      {
        '@type': 'WebPage', '@id': `${url}#webpage`, url, name: tr(pageMeta[path].title, locale),
        description: tr(pageMeta[path].description, locale), inLanguage: locale === 'zh' ? 'zh-Hans' : 'en-CA',
        dateModified: REVIEW_DATE, isPartOf: { '@id': `${SITE_URL}/#website` },
      },
      ...(path ? [{ '@type': 'BreadcrumbList', itemListElement: crumbs.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, ...crumb })) }] : []),
    ],
  };
}

export function sitemapEntries() {
  return PAGE_PATHS.flatMap(path => (['en', 'zh'] as const).map(locale => ({
    url: absoluteUrl(path, locale), lastModified: REVIEW_DATE,
    alternates: { languages: { 'en-CA': absoluteUrl(path), 'zh-Hans': absoluteUrl(path, 'zh'), 'x-default': absoluteUrl(path) } },
  })));
}
