import VslFunnel from '../../../components/VslFunnel';
import {demoFunnel} from '../../../lib/funnel';
export default async function FunnelPage({params}:{params:Promise<{slug:string}>}){const {slug}=await params; const config={...demoFunnel,slug}; return <VslFunnel config={config}/>}
