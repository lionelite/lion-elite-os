from property_acquisition_pipeline import AcquisitionCase, analyze


def test_negative_cash_flow_cannot_be_greenlit_by_tax_benefit():
    case = AcquisitionCase(
        name="Weak deal",
        purchase_price=350000,
        units=2,
        annual_rent=30000,
        annual_operating_expenses=15000,
        annual_debt_service=22000,
        annual_interest=17000,
        cash_invested=90000,
        closing_costs_capitalized=5000,
        land_value=50000,
        cost_seg_5yr=60000,
    )
    result = analyze(case, [])
    assert result["investment_metrics"]["cash_flow_before_tax"] < 0
    assert result["decision"] != "ACQUIRE_CANDIDATE"
    assert "NEGATIVE_CASH_FLOW" in result["risk_flags"]


def test_passive_loss_is_flagged():
    case = AcquisitionCase(
        name="Passive rental",
        purchase_price=300000,
        units=2,
        annual_rent=42000,
        annual_operating_expenses=14000,
        annual_debt_service=20000,
        annual_interest=15000,
        cash_invested=80000,
        closing_costs_capitalized=4000,
        land_value=45000,
    )
    result = analyze(case, [])
    assert "RENTAL_LOSS_MAY_NOT_OFFSET_ACTIVE_BUSINESS_INCOME" in result["risk_flags"]


def test_documentation_controls_acquisition_readiness():
    case = AcquisitionCase(
        name="Documented deal",
        purchase_price=250000,
        units=2,
        annual_rent=48000,
        annual_operating_expenses=14000,
        annual_debt_service=18000,
        annual_interest=13000,
        cash_invested=65000,
        closing_costs_capitalized=4000,
        land_value=35000,
    )
    result = analyze(case, [])
    assert result["documentation_score"] == 0
    assert result["documentation"]["missing"]
