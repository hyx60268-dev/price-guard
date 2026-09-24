# Cost recovery follow-up, 2026-09-24

Observed production run: 35960104253, code 239ea4764d718c8bbf0031054e3dfaae1671f1b7.
Pages succeeded; independent cost acceptance failed. 636 active listings,
29 reviewed, 607 remaining; five attempted and zero automatic references.

The log contained an otherwise complete target with descriptionLength=19,
priceCount=1, sellerFound=true, and target images. The arbitrary 20-character
cutoff labelled this as an access failure. The reader now requires a nonempty
target description; the complete price/seller/image and physical-identity gates
still apply afterwards. Readability is not offer acceptance.

Several leading candidates were explicitly labelled 日本代购 and failed to load.
They already fail procurement's detail rules. Exclude those explicitly labelled
import-intermediary search cards early, without using any card price as evidence.

Detail collection stops after the existing contract has two independent sellers
with coherent, strictly verified detail prices. Rejected variants, duplicate
sellers, search prices and incompatible prices do not satisfy the stop condition.

Price scans and discovery (including cached discovery refreshes) share an
access circuit persisted encrypted in the existing state cache. A challenge or
login-required result defers requests for 1, 2, 4, then at most 6 hours. Only a
verified cost resets the failure streak. The next scheduled run after the delay
may retry; a cooldown expiry does not claim login validity. A user-supplied new
session seed invalidates the old encrypted circuit. No challenge solving,
identity switching or alternate endpoint fallback is introduced.

The dashboard reports the cooldown and earliest retry time. Yahoo scans,
manual costs, fees and existing match corrections are preserved. A cooldown
remains unaccepted and does not count as reviewed coverage.

Validation: regression suite including prior three-shop identity cases, short
description completeness, independent-seller early stop, cross-process encrypted
cooldown and honest acceptance reporting. Local tests are not live product
reviews. Publication and real automatic references require separate cloud proof.
