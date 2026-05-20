import { verifyEnvAtBoot } from "@/lib/env";

export async function register() {
  verifyEnvAtBoot();
}
