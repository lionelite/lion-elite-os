'use client';
import {FormEvent,useEffect,useMemo,useState} from 'react';
import type {FunnelConfig} from '../lib/funnel';

type Step='vsl'|'qualify'|'book'|'done';
async function track(event:string, data:Record<string,unknown>={}){
  try{await fetch('/api/funnel-events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event,...data,ts:new Date().toISOString()})})}catch{}
}
export default function VslFunnel({config}:{config:FunnelConfig}){
 const [step,setStep]=useState<Step>('vsl'); const [showCta,setShowCta]=useState(false); const [lead,setLead]=useState({name:'',email:'',phone:''});
 const [answers,setAnswers]=useState<Record<number,string>>({});
 useEffect(()=>{track('page_view',{slug:config.slug});const t=setTimeout(()=>{setShowCta(true);track('cta_revealed',{slug:config.slug})},config.ctaRevealSeconds*1000);return()=>clearTimeout(t)},[config.slug,config.ctaRevealSeconds]);
 const complete=useMemo(()=>lead.name&&lead.email&&lead.phone,[lead]);
 function start(){track('cta_click',{slug:config.slug});setStep('qualify')}
 function submit(e:FormEvent){e.preventDefault(); if(!complete)return; track('lead_qualified',{slug:config.slug,lead,answers});setStep('book')}
 return <main className="funnel-shell">
  <div className="brand">BUILDPIPELINE <span>VSL</span></div>
  {step==='vsl'&&<section className="funnel-card">
    <div className="eyebrow">AUTOMATED CLIENT ACQUISITION</div><h1>{config.headline}</h1><p className="sub">{config.subheadline}</p>
    <div className="video-wrap">{config.videoUrl?<video controls autoPlay src={config.videoUrl} onPlay={()=>track('video_play',{slug:config.slug})}/>:<div className="video-placeholder"><div className="play">▶</div><strong>VSL VIDEO</strong><span>Paste YouTube, Vimeo, Wistia, or hosted video URL</span></div>}</div>
    <div className="proof-grid">{config.proof.map(x=><div key={x} className="proof">✓ {x}</div>)}</div>
    {showCta?<button className="button wide" onClick={start}>{config.ctaLabel} →</button>:<div className="cta-wait">Keep watching — your next step will appear shortly.</div>}
  </section>}
  {step==='qualify'&&<section className="funnel-card"><div className="eyebrow">STEP 2 OF 3</div><h2>Tell us about your business</h2><p className="sub">We’ll use this to determine the best next step.</p>
   <form onSubmit={submit} className="form"><input required placeholder="Full name" value={lead.name} onChange={e=>setLead({...lead,name:e.target.value})}/><input required type="email" placeholder="Work email" value={lead.email} onChange={e=>setLead({...lead,email:e.target.value})}/><input required placeholder="Phone" value={lead.phone} onChange={e=>setLead({...lead,phone:e.target.value})}/>
   {config.qualificationQuestions.map((q,i)=><label key={q}>{q}<input required value={answers[i]||''} onChange={e=>setAnswers({...answers,[i]:e.target.value})}/></label>)}<button className="button wide" type="submit">Continue to Booking →</button></form></section>}
  {step==='book'&&<section className="funnel-card"><div className="eyebrow">STEP 3 OF 3</div><h2>Book your strategy call</h2><p className="sub">Choose a time that works. BuildPipeline can replace this with the client’s connected calendar.</p><a className="button wide" href={config.calendarUrl} target="_blank" onClick={()=>{track('booking_click',{slug:config.slug});setTimeout(()=>setStep('done'),500)}}>Open Calendar →</a></section>}
  {step==='done'&&<section className="funnel-card"><div className="eyebrow">YOU’RE SET</div><h2>Application received.</h2><p className="sub">Next: trigger confirmation SMS/email, appointment reminders, rep notification, and CRM stage update.</p><div className="success">✓ Funnel conversion recorded</div></section>}
 </main>
}
