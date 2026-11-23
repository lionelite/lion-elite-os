from __future__ import annotations

import sys
from dataclasses import fields

from ..bot import Bot, done, failed, skill
from ..paths import REPO_ROOT

FINANCE_DIR = REPO_ROOT / "finance-intelligence"


def _load():
    if str(FINANCE_DIR) not in sys.path:
        sys.path.insert(0, str(FINANCE_DIR))
    import property_acquisition_pipeline as pap  # noqa: E402
    import real_estate_tax_optimizer as rto  # noqa: E402

    return pap, rto


def _build(cls, data: dict):
    names = {f.name for f in fields(cls)}
    unknown = sorted(set(data) - names)
    if unknown:
        raise ValueError(f"unknown fields: {', '.join(unknown)}")
    return cls(**data)


class FinanceBot(Bot):
    name = "finance"
    description = "Real-estate acquisition and tax analysis using finance-intelligence/."
    keywords = {
        "finance.analyze_property": ["property", "acquisition", "deal", "cap rate", "dscr", "cash flow", "noi"],
        "finance.tax_estimate": ["depreciation", "cost seg", "tax estimate", "passive loss"],
    }

    @skill("finance.analyze_property")
    def analyze_property(self, task):
        """payload: case (AcquisitionCase fields), provided_documents (list)."""
        pap, _ = _load()
        case = task.payload.get("case")
        if not isinstance(case, dict):
            return failed("payload.case must be an object of AcquisitionCase fields")
        try:
            acq = _build(pap.AcquisitionCase, case)
        except (TypeError, ValueError) as exc:
            return failed(f"bad case: {exc}")
        return done(pap.analyze(acq, task.payload.get("provided_documents")))

    @skill("finance.tax_estimate")
    def tax_estimate(self, task):
        """payload: case (PropertyCase fields). Planning estimate, not tax advice."""
        _, rto = _load()
        case = task.payload.get("case")
        if not isinstance(case, dict):
            return failed("payload.case must be an object of PropertyCase fields")
        try:
            prop = _build(rto.PropertyCase, case)
        except (TypeError, ValueError) as exc:
            return failed(f"bad case: {exc}")
        return done(rto.evaluate_property(prop))
