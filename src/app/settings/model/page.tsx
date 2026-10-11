import { redirect } from "next/navigation";

/** Models moved to their own page in the top nav (#441). */
export default function MovedToModels() {
  redirect("/models");
}
