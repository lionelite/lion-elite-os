import {NextRequest,NextResponse} from 'next/server';
export async function POST(req:NextRequest){const payload=await req.json(); console.log('[FUNNEL_EVENT]',JSON.stringify(payload)); return NextResponse.json({ok:true});}
