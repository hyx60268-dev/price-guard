// Only fixed reason codes may enter public operational aggregates. Never return
// an arbitrary matcher error, title, URL, or exception text.
const strictReasons=new Set([
 'saved_user_correction','own_seller','title_rejected','weak_title','detail_id_mismatch','detail_images_unavailable',
 'shipping_unconfirmed','sale_description_unavailable','not_open','detail_price_unavailable','detail_seller_changed_or_missing',
 'defect','condition_or_packaging_mismatch','physical_product_type_unconfirmed','description_color_mismatch','sale_unit_mismatch',
 'bonus_terms_inconsistent','bonus_terms_mismatch','bonus_terms_unconfirmed','explicit_variant_mismatch',
 'primary_variant_unconfirmed','collectible_variant_image_unconfirmed','lottery_series_unconfirmed','detail_mismatch',
 'weak_detail_title','physical_image_unconfirmed','different_variant','different_product_type','different_quantity',
]);
export const sharedStrictReason=value=>strictReasons.has(value)?value:'strict_other';
