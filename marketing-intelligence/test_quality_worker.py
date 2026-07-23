import unittest

from quality_worker import hard_product_check


class ProductGateTests(unittest.TestCase):
    def test_mismatched_vial_fails(self):
        asset = {
            "brand": "Lion Elite Wellness",
            "product_name": "cjc-1295 / ipamorelin",
            "vial_product_name": "selank",
            "headline": "CJC-1295 / Ipamorelin: pathway research",
            "caption": "CJC-1295 / Ipamorelin research education.",
        }
        failures = hard_product_check(asset)
        self.assertTrue(failures)

    def test_matching_product_passes(self):
        asset = {
            "brand": "Lion Elite Wellness",
            "product_name": "tesamorelin",
            "vial_product_name": "tesamorelin",
            "headline": "Tesamorelin: pathway research",
            "caption": "Tesamorelin research education.",
            "expected_quantity": "5 mg",
            "vial_quantity": "5 mg",
        }
        self.assertEqual(hard_product_check(asset), [])


if __name__ == "__main__":
    unittest.main()
