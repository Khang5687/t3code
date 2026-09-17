import { createFileRoute } from "@tanstack/react-router";

import { PxpipeSidecarSettings } from "../components/settings/PxpipeSidecarSettings";

export const Route = createFileRoute("/settings/sidecars")({
  component: PxpipeSidecarSettings,
});
