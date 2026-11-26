"""Two peptide bots with deliberately different jobs.

research_peptides serves the Lion Elite Wellness storefront: literature lookups
and Research-Use-Only product copy that must pass the repo's RUO validator.

clinical_peptides is evidence research (trials, clinical literature) for the
owner and for B2B clinic conversations. Its briefs are always internal: they
may discuss what trials studied, which is exactly the language RUO customer
copy may not carry.
"""

from __future__ import annotations

from .. import llm, sources
from ..bot import Bot, done, failed, skill
from ..drafts import gated_draft

# Must contain the validator's exact phrase (RESEARCH_DISCLAIMER_PHRASE in
# lib/social/social-compliance.js), or every draft fails the check.
RUO_FOOTER = "For laboratory research purposes only. Not for human consumption."


class ResearchPeptideBot(Bot):
    name = "research_peptides"
    description = "Lion Elite Wellness (RUO): PubMed lookups, RUO copy checks, compliant product-copy drafts."
    keywords = {
        "research_peptides.literature": ["pubmed", "studies on", "papers on", "literature"],
        "research_peptides.product_copy": ["product description", "product copy", "vial copy"],
        "research_peptides.copy_check": ["ruo check", "research use only"],
    }

    @skill("research_peptides.literature")
    def literature(self, task):
        """payload: term, max (default 10). PubMed titles, journals, years, links."""
        term = task.payload.get("term") or task.payload.get("request")
        if not term:
            return failed("payload.term is required")
        return done({"term": term, "articles": sources.pubmed_search(term, int(task.payload.get("max", 10)))})

    @skill("research_peptides.copy_check")
    def copy_check(self, task):
        """payload: text. Research-only mode, disclaimer required."""
        text = task.payload.get("text")
        if not text:
            return failed("payload.text is required")
        return done(gated_draft(text, "research-only", require_disclaimer=True))

    @skill("research_peptides.product_copy")
    def product_copy(self, task):
        """payload: product, facts (purity, size, form, CAS, storage - only what is real)."""
        product = task.payload.get("product") or task.payload.get("request")
        if not product:
            return failed("payload.product is required")
        prompt = (
            f"Write a premium storefront product description for the research compound '{product}'.\n"
            f"Verified facts (use only these, [NEEDS: ...] for anything else): {task.payload.get('facts', {})}\n"
            "Strict Research-Use-Only rules: no dosing, reconstitution, administration, injection, cycles, "
            "human or animal use, benefits, results, treatment, healing, fat loss, muscle, anti-aging or any "
            "outcome language. Do not write any quantity with mg, mcg, IU or mL units (the validator treats them as "
            "dosing; vial size belongs in the product's variant field). Describe it as a laboratory research material: identity, specifications, "
            "quality documentation, storage, handling for laboratory use. Under 150 words. "
            f"End with exactly: {RUO_FOOTER}"
        )
        text = llm.ask(prompt, effort="low")["text"].strip()
        return done(gated_draft(text, "research-only", require_disclaimer=True))


class ClinicalPeptideBot(Bot):
    name = "clinical_peptides"
    description = "Clinical evidence on peptides: ClinicalTrials.gov, clinical PubMed, cited internal briefs."
    keywords = {
        "clinical_peptides.trials": ["clinical trial", "trials for", "nct", "phase 3", "phase 2"],
        "clinical_peptides.evidence_brief": ["evidence brief", "what does the evidence say", "clinical evidence"],
    }

    @skill("clinical_peptides.trials")
    def trials(self, task):
        """payload: intervention, condition, status (list), max (default 10)."""
        p = task.payload
        intervention = p.get("intervention") or p.get("request")
        if not intervention:
            return failed("payload.intervention is required")
        return done({"intervention": intervention,
                     "trials": sources.trials_search(intervention, p.get("condition"), p.get("status"),
                                                     int(p.get("max", 10)))})

    @skill("clinical_peptides.literature")
    def literature(self, task):
        """payload: term, max. PubMed limited to clinical trials, RCTs and meta-analyses."""
        term = task.payload.get("term") or task.payload.get("request")
        if not term:
            return failed("payload.term is required")
        return done({"term": term, "articles": sources.pubmed_search(term, int(task.payload.get("max", 10)),
                                                                      clinical_only=True)})

    @skill("clinical_peptides.evidence_brief")
    def evidence_brief(self, task):
        """payload: compound, condition (optional). Fetches trials + literature, then a cited internal brief."""
        p = task.payload
        compound = p.get("compound") or p.get("request")
        if not compound:
            return failed("payload.compound is required")
        # Supplied sources are used as given (an empty list means "none"), fetched only when absent.
        trials = p["trials"] if "trials" in p else sources.trials_search(compound, p.get("condition"), page_size=15)
        articles = p["articles"] if "articles" in p else sources.pubmed_search(
            f"{compound} {p.get('condition') or ''}".strip(), 15, clinical_only=True)
        if not trials and not articles:
            return done({"compound": compound, "brief": None, "internal_only": True,
                         "note": "No registered trials or clinical publications found. That absence is the finding."})
        prompt = (
            f"Write an internal evidence brief on {compound}"
            f"{' for ' + p['condition'] if p.get('condition') else ''}, using ONLY these sources.\n"
            f"Trials: {trials}\nPublications (titles only, no abstracts): {articles}\n"
            "Sections: what has been studied, trial phases and status, what is registered vs published, gaps "
            "and open questions, regulatory status if stated in a source. Cite every claim with its NCT id or "
            "PMID. Where only a title is available, say the finding is not established from the title. Do not "
            "give dosing or treatment recommendations."
        )
        brief = llm.ask(prompt, effort="high")["text"]
        return done({"compound": compound, "brief": brief, "sources": {"trials": trials, "articles": articles},
                     "internal_only": True,
                     "note": "Internal only. Clinical discussion may not be reused in RUO storefront or outreach copy."})
