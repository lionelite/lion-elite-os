import { notFound } from 'next/navigation';
import VslFunnel from '../../../components/VslFunnel';
import { getFunnel } from '../../../lib/funnel';

export default async function FunnelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = await getFunnel(slug);
  if (!found) notFound();
  return <VslFunnel config={found.config} source={found.source} />;
}
