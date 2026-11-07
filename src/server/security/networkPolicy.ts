/**
 * Aegis Orchestrator - Network Security & SSRF Protection Policy
 * 
 * Enforces strict boundary controls on any caller-supplied endpoints,
 * blocking loopback, private RFC1918 ranges, cloud metadata services,
 * and dangerous protocols.
 */

import { URL } from 'url';
import dns from 'dns/promises';
import net from 'net';

export interface NetworkValidationResult {
  allowed: boolean;
  reason?: string;
  sanitizedUrl?: string;
}

const BLOCKED_IP_PREFIXES = [
  '127.',        // IPv4 loopback
  '169.254.',    // IPv4 link-local & cloud metadata (AWS/GCP/Azure)
  '10.',         // RFC1918 class A
  '192.168.',    // RFC1918 class C
  '0.',          // Current network
];

// RFC1918 Class B: 172.16.0.0 - 172.31.255.255
function isClassBPrivate(ip: string): boolean {
  if (!ip.startsWith('172.')) return false;
  const parts = ip.split('.');
  if (parts.length < 2) return false;
  const second = parseInt(parts[1], 10);
  return second >= 16 && second <= 31;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc00:') || normalized.startsWith('fd00:')) return true;
    return false;
  }

  for (const prefix of BLOCKED_IP_PREFIXES) {
    if (ip.startsWith(prefix)) return true;
  }

  if (isClassBPrivate(ip)) return true;

  return false;
}

/**
 * Validates a target URL against SSRF policy.
 * @param inputUrl Target URL requested by caller
 * @param allowLocalhost Only true during isolated local integration tests if explicitly flagged
 */
export async function validateOutboundUrl(
  inputUrl: string,
  allowLocalhost = process.env.NODE_ENV === 'test' && process.env.AEGIS_ALLOW_TEST_LOCALHOST === '1'
): Promise<NetworkValidationResult> {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { allowed: false, reason: 'Empty or invalid URL provided' };
  }

  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return { allowed: false, reason: 'Malformed URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Disallowed protocol: ${parsed.protocol}. Only HTTP and HTTPS are permitted.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicit loopback hostname check
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1') {
    if (!allowLocalhost) {
      return { allowed: false, reason: 'Access to loopback/localhost is prohibited by network security policy' };
    }
  }

  // AWS/GCP metadata hostname/IP check
  if (hostname === 'metadata.google.internal' || hostname === '169.254.169.254' || hostname.includes('169.254')) {
    return { allowed: false, reason: 'Access to cloud instance metadata service is strictly prohibited' };
  }

  // If already an IP address, validate directly
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname) && !allowLocalhost) {
      return { allowed: false, reason: `Access to private IP range ${hostname} is blocked by SSRF policy` };
    }
    return { allowed: true, sanitizedUrl: parsed.toString() };
  }

  // DNS resolution to prevent DNS rebinding or resolving to internal RFC1918 IPs
  try {
    const lookup = await dns.lookup(hostname);
    if (isPrivateOrReservedIp(lookup.address) && !allowLocalhost) {
      return {
        allowed: false,
        reason: `Target hostname ${hostname} resolved to private/internal IP ${lookup.address}`,
      };
    }
  } catch (err: any) {
    return { allowed: false, reason: `DNS resolution failed for hostname ${hostname}: ${err.message}` };
  }

  return { allowed: true, sanitizedUrl: parsed.toString() };
}
