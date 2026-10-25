import { WEB_PRODUCT_ID, type ActivationType } from "./constants/index.js";
import type { PlanEntitlements } from "./schemas/plans.js";

/**
 * Shared entitlement checks. The API calls these on every protected request;
 * the Web App may call them for display only (route guards are usability, not security).
 */
export function canAccessFeature(e: PlanEntitlements | null | undefined, feature: string): boolean {
  return !!e && e.web_access && e.features.includes(feature);
}

export function canUseProduct(e: PlanEntitlements, product: string, platform: ActivationType): boolean {
  if (platform === "web") return product === WEB_PRODUCT_ID && e.web_access;
  return product !== WEB_PRODUCT_ID && e.ea_products.includes(product);
}

export function canUsePlatform(e: PlanEntitlements, platform: ActivationType): boolean {
  if (platform === "web") return e.web_access;
  return e.ea_platforms.includes(platform);
}
