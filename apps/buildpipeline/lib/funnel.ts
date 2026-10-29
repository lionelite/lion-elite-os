export type FunnelConfig={
 slug:string; headline:string; subheadline:string; videoUrl:string; ctaRevealSeconds:number;
 ctaLabel:string; calendarUrl:string; proof:string[]; qualificationQuestions:string[];
};
export const demoFunnel:FunnelConfig={
 slug:'demo',
 headline:'Turn More Qualified Prospects Into Booked Sales Calls',
 subheadline:'Watch the short presentation to see how BuildPipeline finds, qualifies, nurtures, and books prospects automatically.',
 videoUrl:'',
 ctaRevealSeconds:8,
 ctaLabel:'See If You Qualify',
 calendarUrl:'https://calendly.com/',
 proof:['Automated lead capture','Qualification before booking','Email + SMS follow-up ready','End-to-end conversion tracking'],
 qualificationQuestions:['What is your company name?','What is your biggest growth bottleneck?','How many qualified sales calls do you book per month?','What is your target monthly revenue?']
};
