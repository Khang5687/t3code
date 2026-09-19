import { useNavigation } from "@react-navigation/native";
import {
  describePxpipeStatus,
  type PxpipeStatusDisplay,
} from "@t3tools/client-runtime/state/pxpipe";
import type { EnvironmentId, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  type PxpipeRoutableInstance,
  pxpipeRoutableInstances,
  pxpipeRoutingPatch,
} from "./SettingsSidecarsRouteScreen.logic";

// Same palette as the connection dot, drawn once and never animated.
const TONE_COLORS: Readonly<Record<PxpipeStatusDisplay["tone"], string>> = {
  neutral: "#9ca3af",
  pending: "#f59e0b",
  good: "#34d399",
  warning: "#f59e0b",
  bad: "#ef4444",
};

/**
 * Fork-only (ADR 0004). Read-only pxpipe status plus the per-instance routing
 * switch, one section per connected environment because the sidecar and the
 * instances that route through it both belong to an environment. Starting,
 * stopping and configuring the sidecar stay on web and desktop.
 */
export function SettingsSidecarsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();

  const routable = environments.flatMap((environment) => {
    const serverConfig = environment.serverConfig;
    if (environment.connection.phase !== "connected" || serverConfig === null) return [];
    const instances = pxpipeRoutableInstances(serverConfig.providers, serverConfig.settings);
    return instances.length === 0
      ? []
      : [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            settings: serverConfig.settings,
            instances,
          },
        ];
  });

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="pxpipe" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {routable.length === 0 ? (
          <View collapsable={false} className="gap-2 rounded-[24px] bg-card px-5 py-6">
            <Text className="text-lg text-foreground">No Claude instances</Text>
            <Text className="text-sm leading-normal text-foreground-muted">
              Connect an environment that has a Claude provider to route it through pxpipe.
            </Text>
          </View>
        ) : (
          routable.map((environment) => (
            <EnvironmentPxpipeSection
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              settings={environment.settings}
              instances={environment.instances}
            />
          ))
        )}
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Routing sends an instance&apos;s Anthropic traffic through pxpipe, which turns off
          /remote-control and claude.ai connectors for that instance. Start, stop and configure the
          sidecar from Settings &gt; Sidecars &gt; pxpipe on web or desktop.
        </Text>
      </ScrollView>
    </View>
  );
}

function EnvironmentPxpipeSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly settings: ServerSettings;
  readonly instances: ReadonlyArray<PxpipeRoutableInstance>;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "pxpipe routing update",
    reportFailure: true,
  });
  // The supervisor broadcasts nothing, so the state atom polls while this
  // section is mounted and drops its poll a few seconds after unmount.
  const state = useEnvironmentQuery(
    serverEnvironment.sidecarPxpipeState({ environmentId: props.environmentId, input: {} }),
  ).data;
  const status = describePxpipeStatus(state ?? null);

  const setRouted = (instanceId: ProviderInstanceId, routed: boolean) => {
    // `providerInstances` is a whole-map replacement, so the patch is built
    // from the settings this render drew the switches from.
    const patch = pxpipeRoutingPatch(props.settings, instanceId, routed);
    if (patch === null) return;
    void updateSettings({ environmentId: props.environmentId, input: { patch } });
  };

  return (
    <SettingsSection title={props.label}>
      <View className="flex-row items-center gap-4 p-4">
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: TONE_COLORS[status.tone],
          }}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-lg text-foreground">{status.label}</Text>
          {status.description ? (
            <Text className="text-sm leading-normal text-foreground-muted">
              {status.description}
            </Text>
          ) : null}
          {state?.lastError ? (
            <Text className="text-sm leading-normal text-foreground-muted">{state.lastError}</Text>
          ) : null}
        </View>
      </View>
      {props.instances.map((instance) => (
        <View key={instance.instanceId} className="border-t border-border-subtle">
          <SettingsSwitchRow
            icon="arrow.triangle.swap"
            label={instance.label}
            subtitle={instance.inactiveReason ?? instance.remoteFeaturesStatus}
            value={instance.routed}
            onValueChange={(routed) => setRouted(instance.instanceId, routed)}
          />
        </View>
      ))}
    </SettingsSection>
  );
}
