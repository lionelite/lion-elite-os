from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional

@dataclass
class PropertyCase:
    name: str
    purchase_price: float
    land_value: float
    closing_costs_capitalized: float
    annual_rent: float
    annual_operating_expenses: float
    annual_interest: float
    cost_seg_5yr: float = 0.0
    cost_seg_7yr: float = 0.0
    cost_seg_15yr: float = 0.0
    placed_in_service_year: int = 2026
    active_participation: bool = False
    material_participation: bool = False
    real_estate_professional: bool = False
    at_risk_amount: Optional[float] = None
    basis_limit: Optional[float] = None


def straight_line_27_5(building_basis: float) -> float:
    return max(0.0, building_basis) / 27.5


def evaluate_property(case: PropertyCase) -> dict:
    total_basis = case.purchase_price + case.closing_costs_capitalized
    building_basis = max(0.0, total_basis - case.land_value)

    reclassified = max(0.0, case.cost_seg_5yr + case.cost_seg_7yr + case.cost_seg_15yr)
    remaining_building_basis = max(0.0, building_basis - reclassified)

    base_depreciation = straight_line_27_5(remaining_building_basis)
    operating_income_before_depr = case.annual_rent - case.annual_operating_expenses - case.annual_interest

    # This engine intentionally does NOT assume bonus-depreciation eligibility.
    # It flags the reclassified basis for CPA review because eligibility depends on
    # acquisition/placed-in-service dates, property class, elections, and current law.
    proposed_loss_before_special_depr = operating_income_before_depr - base_depreciation

    if case.real_estate_professional and case.material_participation:
        passive_character = "potentially_nonpassive_subject_to_full_fact_review"
    else:
        passive_character = "generally_passive"

    limits = []
    if case.at_risk_amount is not None:
        limits.append({"type": "at_risk", "amount": case.at_risk_amount})
    if case.basis_limit is not None:
        limits.append({"type": "basis", "amount": case.basis_limit})
    limits.append({"type": "passive_activity", "treatment": passive_character})

    return {
        "property": case.name,
        "total_basis": round(total_basis, 2),
        "building_basis": round(building_basis, 2),
        "land_basis": round(case.land_value, 2),
        "cost_seg_reclassified_basis": round(reclassified, 2),
        "remaining_27_5yr_basis": round(remaining_building_basis, 2),
        "annual_27_5yr_depreciation_estimate": round(base_depreciation, 2),
        "operating_income_before_depreciation": round(operating_income_before_depr, 2),
        "estimated_tax_income_before_special_depreciation": round(proposed_loss_before_special_depr, 2),
        "activity_character": passive_character,
        "limitation_checks": limits,
        "bonus_depreciation_status": "CPA_REVIEW_REQUIRED",
        "cost_segregation_status": "CPA_REVIEW_REQUIRED",
        "required_documents": [
            "closing_statement",
            "purchase_contract",
            "appraisal_or_land_building_allocation_support",
            "placed_in_service_evidence",
            "loan_statements",
            "rent_roll_and_leases",
            "operating_expense_invoices",
            "cost_segregation_study_if_used",
            "participation_time_log_if_tax_treatment_depends_on_participation",
        ],
        "case_input": asdict(case),
    }
