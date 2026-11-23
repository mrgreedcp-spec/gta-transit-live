import { notFound } from 'next/navigation';
import { GuidePage } from '@/components/guide-page';
import { isPagePath, PAGE_PATHS } from '@/lib/content';
import { metadataFor } from '@/lib/seo';
type Props = { params: Promise<{ slug: string[] }> };
export const dynamicParams = false;
export function generateStaticParams() { return PAGE_PATHS.filter(Boolean).map(path => ({ slug: path.split('/') })); }
export async function generateMetadata({ params }: Props) { const path = (await params).slug.join('/'); if (!isPagePath(path)) notFound(); return metadataFor(path, 'en'); }
export default async function Page({ params }: Props) { const path = (await params).slug.join('/'); if (!isPagePath(path)) notFound(); return <GuidePage path={path} locale="en"/>; }
