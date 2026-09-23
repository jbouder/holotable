import { redirect } from "next/navigation";
import { DEFAULT_SETTINGS_HREF } from "@/lib/settings";

export default function SettingsIndex() {
  redirect(DEFAULT_SETTINGS_HREF);
}
