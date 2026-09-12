/**
 * Use keyword to VOA description pattern.
 *
 * Kept separate from the parser so the words a person types and the words VOA
 * publishes stay independent: "warehouse" is what a consultant says, "WAREHOUSE
 * AND PREMISES" is what the rating list holds, and neither should have to bend
 * to the other.
 *
 * Patterns are Postgres regex alternatives, matched case-insensitively against
 * primary_description.
 */
export const USE_SQL_PATTERNS: Record<string, string[]> = {
  warehouse: ["WAREHOUSE", "STORE AND PREMISES", "DISTRIBUTION"],
  industrial: ["FACTORY", "WORKSHOP", "INDUSTRIAL"],
  office: ["OFFICE"],
  shop: ["SHOP", "RETAIL", "SHOWROOM"],
  restaurant: ["RESTAURANT", "CAFE"],
  hotel: ["HOTEL"],
  school: ["SCHOOL", "COLLEGE"],
  surgery: ["SURGERY", "CLINIC", "HEALTH CENTRE"],
};
