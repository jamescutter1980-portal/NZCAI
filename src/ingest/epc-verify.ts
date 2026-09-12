/**
 * Task 0 endpoint check.
 *
 *   npm run epc:verify -- SW1A1AA
 *
 * Queries both the new host and the legacy one for the same postcode and
 * compares. The brief asks to confirm that domestic, non-domestic and DEC
 * lookups all still return UPRNs, so the output breaks the count down per
 * register and per UPRN source - an assessor-entered UPRN is not the same grade
 * of identifier as an address-matched one.
 */
import { certificatesByPostcode, EPC_REGISTERS, LEGACY_BASE, type EpcRegister } from "@/lib/site-intel/epc";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";

const NEW_BASE = "https://get-energy-performance-data.communities.gov.uk";

async function probe(base: string, postcode: string): Promise<void> {
  console.log(`\n${base}`);

  for (const register of EPC_REGISTERS) {
    const result = await certificatesByPostcode(postcode, {
      base,
      registers: [register as EpcRegister],
    });

    if (result.unavailable) {
      console.log(`  ${RED}FAIL${OFF} ${register.padEnd(13)} ${DIM}${result.unavailable.slice(0, 110)}${OFF}`);
      continue;
    }

    const total = result.certificates.length;
    const withUprn = result.certificates.filter((c) => c.uprn).length;
    const matched = result.certificates.filter((c) => c.uprnSource === "address_matched").length;
    const assessor = result.certificates.filter((c) => c.uprnSource === "energy_assessor").length;

    const mark = total === 0 ? `${DIM}none${OFF}` : `${GREEN}${total}${OFF}`;
    console.log(
      `  ${total ? GREEN + "OK  " : DIM + "----"}${OFF} ${register.padEnd(13)} ` +
      `${mark} certificates, ${withUprn} with UPRN ` +
      `${DIM}(${matched} address-matched, ${assessor} assessor-entered)${OFF}`,
    );

    if (total > 0 && withUprn === 0) {
      console.log(`       ${YELLOW}No UPRNs returned - step (a) of the resolution chain cannot work here.${OFF}`);
    }

    const sample = result.certificates[0];
    if (sample) {
      console.log(`       ${DIM}e.g. ${sample.address} | ${sample.rating ?? "no rating"} | ${sample.floorAreaM2 ?? "?"} m²${OFF}`);
    }
  }
}

async function main(): Promise<void> {
  const postcode = process.argv[2];
  if (!postcode) throw new Error("Usage: npm run epc:verify -- <postcode>");

  if (!process.env.EPC_API_EMAIL || !process.env.EPC_API_KEY) {
    console.log(
      `${YELLOW}EPC_API_EMAIL and EPC_API_KEY are not set.${OFF}\n` +
      `Register free at https://epc.opendatacommunities.org/login-or-register\n`,
    );
  }

  console.log(`Task 0 — EPC register check for ${postcode}`);
  await probe(NEW_BASE, postcode);
  await probe(LEGACY_BASE, postcode);

  console.log(
    `\n${DIM}If the two hosts disagree, record it in PRELAUNCH.md TICKET-01 before` +
    ` changing EPC_API_BASE.${OFF}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
