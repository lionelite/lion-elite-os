from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from typing import Any

from real_estate_tax_optimizer import PropertyCase, evaluate_property


@dataclass
class AcquisitionCase:
    name: str
    purchase_price: float
    units: int
    annual_rent: float
    annual_operating_expenses: float
    annual_debt_service: float
    annual_interest: float
    cash_invested: float
    closing_costs_capitalized: float
    land_value: float
    estimated_after_repair_value: float | None = None
    renovation_budget: float = 0.0
    cost_seg_5yr: float = 0.0
    cost_seg_7yr: float = 0.0
    cost_seg_15yr: float = 0.0
    real_estate_professional: bool = False
    material_participation: bool = False
    at_risk_amount: float | None = None
    basis_limit: float | None = None


def pct(value: float) -> float:
    return round(value * 100, 2)


def clamp(value: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, value))


def investment_metrics(case: AcquisitionCase) -> dict[str, Any]:
    noi = case.annual_rent - case.annual_operating_expenses
    cash_flow = noi - case.annual_debt_service
    cap_rate = noi / case.purchase_price if case.purchase_price else 0
    coc = cash_flow / case.cash_invested if case.cash_invested else 0
    dscr = noi / case.annual_debt_service if case.annual_debt_service else None

    all_in_basis = case.purchase_price + case.closing_costs_capitalized + case.renovation_budget
    equity_creation = None
    if case.estimated_after_repair_value is not None:
        equity_creation = case.estimated_after_repair_value - all_in_basis

    return {
        "noi": round(noi, 2),
        "cash_flow_before_tax": round(cash_flow, 2),
        "cap_rate_pct": pct(cap_rate),
        "cash_on_cash_pct": pct(coc),
        "dscr": round(dscr, 3) if dscr is not None else None,
        "all_in_basis": round(all_in_basis, 2),
        "estimated_equity_creation": round(equity_creation, 2) if equity_creation is not None else None,
    }


def investment_score(metrics: dict[str, Any]) -> float:
    score = 0.0
    score += clamp((metrics["cap_rate_pct"] - 3.5) * 9, 0, 25)
    score += clamp((metrics["cash_on_cash_pct"] + 2) * 2, 0, 25)

    dscr = metrics.get("dscr")
    if dscr is not None:
        score += clamp((dscr - 0.8) * 50, 0, 25)

    equity = metrics.get("estimated_equity_creation")
    if equity is None:
        score += 10
    elif equity > 0:
        score += clamp((equity / max(metrics["all_in_basis"], 1)) * 100, 0, 25)

    return round(clamp(score), 1)


def tax_score(tax: dict[str, Any]) -> float:
    score = 20.0
    building_basis = tax.get("building_basis", 0) or 0
    reclassified = tax.get("cost_seg_reclassified_basis", 0) or 0
    depreciation = tax.get("annual_27_5yr_depreciation_estimate", 0) or 0

    if building_basis > 0:
        score += clamp((depreciation / building_basis) * 300, 0, 20)
        score += clamp((reclassified / building_basis) * 100, 0, 25)

    if tax.get("activity_character", "").startswith("potentially_nonpassive"):
        score += 20
    else:
        score += 5

    if tax.get("bonus_depreciation_status") == "CPA_REVIEW_REQUIRED":
        score += 5

    return round(clamp(score), 1)


def documentation_score(tax: dict[str, Any], provided_documents: list[str] | None = None) -> dict[str, Any]:
    provided = set(provided_documents or [])
    required = set(tax.get("required_documents", []))
    missing = sorted(required - provided)
    completion = 100.0 if not required else round((len(required & provided) / len(required)) * 100, 1)
    return {"score": completion, "missing": missing, "provided": sorted(provided)}


def acquisition_decision(investment: float, tax: float, docs: float) -> str:
    weighted = investment * 0.55 + tax * 0.25 + docs * 0.20
    if investment < 45:
        return "REJECT_OR_RENEGOTIATE"
    if weighted >= 78 and docs >= 75:
        return "ACQUIRE_CANDIDATE"
    if weighted >= 60:
        return "DUE_DILIGENCE"
    return "RENEGOTIATE_OR_PASS"


def analyze(case: AcquisitionCase, provided_documents: list[str] | None = None) -> dict[str, Any]:
    metrics = investment_metrics(case)
    tax_case = PropertyCase(
        name=case.name,
        purchase_price=case.purchase_price,
        land_value=case.land_value,
        closing_costs_capitalized=case.closing_costs_capitalized,
        annual_rent=case.annual_rent,
        annual_operating_expenses=case.annual_operating_expenses,
        annual_interest=case.annual_interest,
        cost_seg_5yr=case.cost_seg_5yr,
        cost_seg_7yr=case.cost_seg_7yr,
        cost_seg_15yr=case.cost_seg_15yr,
        material_participation=case.material_participation,
        real_estate_professional=case.real_estate_professional,
        at_risk_amount=case.at_risk_amount,
        basis_limit=case.basis_limit,
    )
    tax = evaluate_property(tax_case)
    docs = documentation_score(tax, provided_documents)

    i_score = investment_score(metrics)
    t_score = tax_score(tax)
    decision = acquisition_decision(i_score, t_score, docs["score"])

    return {
        "property": case.name,
        "decision": decision,
        "investment_score": i_score,
        "tax_strategy_score": t_score,
        "documentation_score": docs["score"],
        "investment_metrics": metrics,
        "tax_analysis": tax,
        "documentation": docs,
        "risk_flags": build_risk_flags(case, metrics, tax, docs),
        "next_actions": build_next_actions(case, metrics, tax, docs),
        "case_input": asdict(case),
    }


def build_risk_flags(case, metrics, tax, docs):
    flags = []
    if metrics["cash_flow_before_tax"] < 0:
        flags.append("NEGATIVE_CASH_FLOW")
    if metrics.get("dscr") is not None and metrics["dscr"] < 1.20:
        flags.append("WEAK_DSCR")
    if tax["activity_character"] == "generally_passive":
        flags.append("RENTAL_LOSS_MAY_NOT_OFFSET_ACTIVE_BUSINESS_INCOME")
    if tax["cost_segregation_status"] == "CPA_REVIEW_REQUIRED" and tax["cost_seg_reclassified_basis"] > 0:
        flags.append("COST_SEG_REQUIRES_SUPPORT")
    if docs["score"] < 100:
        flags.append("DOCUMENTATION_INCOMPLETE")
    return flags


def build_next_actions(case, metrics, tax, docs):
    actions = []
    if metrics["cash_flow_before_tax"] <= 0:
        actions.append("Renegotiate price, improve rents, reduce debt cost, or reduce operating expenses before acquisition.")
    if tax["activity_character"] == "generally_passive":
        actions.append("CPA Expert must determine whether projected losses are currently usable or suspended under passive-activity rules.")
    if tax["cost_seg_reclassified_basis"] > 0:
        actions.append("Obtain/validate a defensible cost-segregation study before accelerated depreciation is treated as tax-ready.")
    for doc in docs["missing"]:
        actions.append(f"Collect: {doc}")
    actions.append("Compare 5-year after-tax net worth against the no-purchase baseline before approval.")
    return actions


if __name__ == "__main__":
    import sys
    payload = json.load(sys.stdin)
    case = AcquisitionCase(**payload["case"])
    print(json.dumps(analyze(case, payload.get("provided_documents")), indent=2))
