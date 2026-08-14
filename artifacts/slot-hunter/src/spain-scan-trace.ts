/**
 * Trace diagnostique d'un cycle scan Espagne — persistée dans spainWatcherScans.scanTrace.
 * Alimente l'onglet « Historique scans » du dashboard admin.
 */

export interface SpainScanTraceMain {
  bytes: number;
  ok: boolean;
  serviceContainer: boolean;
  dialogConfirm: boolean;
  isSpa?: boolean;
  fromCache?: boolean;
  cfRay?: string;
}

export interface SpainScanTraceInitConfig {
  bytes: number;
  ok: boolean;
}

export interface SpainScanTraceService {
  bytes: number;
  ok: boolean;
  /** null = champ absent du payload getservices/ */
  allowAppointment: boolean | null;
  /** Reprise des signaux /main/ pour lecture rapide dans l'historique */
  serviceContainer: boolean;
  dialogConfirm: boolean;
  count: number;
  names?: string;
}

export interface SpainScanTraceAgenda {
  serviceId: string;
  serviceName: string;
  bytes: number;
  ok: boolean;
  agendaId?: string;
}

export interface SpainScanTraceDatetime {
  serviceId: string;
  serviceName: string;
  month: string;
  bytes: number;
  slots: number;
  ok: boolean;
}

export interface SpainScanTraceBooking {
  applicant: string;
  status: string;
  detail?: string;
  ms?: number;
}

export interface SpainScanTrace {
  ipRotations?: number;
  main?: SpainScanTraceMain;
  initConfig?: SpainScanTraceInitConfig;
  service?: SpainScanTraceService;
  agendas: SpainScanTraceAgenda[];
  datetimes: SpainScanTraceDatetime[];
  bookings: SpainScanTraceBooking[];
}

let _active: SpainScanTrace | null = null;

/** Signaux /main/ partagés avec l'étape service (serviceContainer + dialogConfirm). */
let _mainSignals: Pick<SpainScanTraceMain, "serviceContainer" | "dialogConfirm"> = {
  serviceContainer: false,
  dialogConfirm: false,
};

export function beginSpainScanTrace(): void {
  _active = { agendas: [], datetimes: [], bookings: [] };
  _mainSignals = { serviceContainer: false, dialogConfirm: false };
}

export function getSpainScanTrace(): SpainScanTrace | null {
  return _active;
}

export function takeSpainScanTrace(): SpainScanTrace | undefined {
  const trace = _active;
  _active = null;
  _mainSignals = { serviceContainer: false, dialogConfirm: false };
  return trace ?? undefined;
}

export function setSpainScanIpRotations(count: number): void {
  if (_active) _active.ipRotations = count;
}

export function recordSpainScanMain(entry: Omit<SpainScanTraceMain, "serviceContainer" | "dialogConfirm"> & {
  serviceContainer: boolean;
  dialogConfirm: boolean;
}): void {
  if (!_active) return;
  _mainSignals = {
    serviceContainer: entry.serviceContainer,
    dialogConfirm: entry.dialogConfirm,
  };
  _active.main = entry;
}

export function recordSpainScanInitConfig(bytes: number): void {
  if (!_active) return;
  _active.initConfig = { bytes, ok: bytes > 0 };
}

export function recordSpainScanService(
  bytes: number,
  allowAppointment: boolean | null,
  services: Array<{ serviceId: string; serviceName: string }>,
): void {
  if (!_active) return;
  _active.service = {
    bytes,
    ok: bytes > 0 && services.length > 0,
    allowAppointment,
    serviceContainer: _mainSignals.serviceContainer,
    dialogConfirm: _mainSignals.dialogConfirm,
    count: services.length,
    names: services.length > 0
      ? services.map((s) => `"${s.serviceName}" (${s.serviceId})`).join(", ")
      : undefined,
  };
}

export function recordSpainScanAgenda(entry: SpainScanTraceAgenda): void {
  _active?.agendas.push(entry);
}

export function recordSpainScanDatetime(entry: SpainScanTraceDatetime): void {
  _active?.datetimes.push(entry);
}

export function recordSpainScanBooking(entry: SpainScanTraceBooking): void {
  _active?.bookings.push(entry);
}

/** Ajoute une entrée booking à une trace déjà extraite du probe (post-booking). */
export function appendSpainScanBooking(
  trace: SpainScanTrace | undefined,
  entry: SpainScanTraceBooking,
): SpainScanTrace {
  if (!trace) return { agendas: [], datetimes: [], bookings: [entry] };
  trace.bookings.push(entry);
  return trace;
}

/** Sérialise pour Convex (JSON string). */
export function serializeSpainScanTrace(trace: SpainScanTrace | undefined): string | undefined {
  if (!trace) return undefined;
  const hasContent =
    trace.main ||
    trace.initConfig ||
    trace.service ||
    trace.agendas.length > 0 ||
    trace.datetimes.length > 0 ||
    trace.bookings.length > 0 ||
    (trace.ipRotations ?? 0) > 0;
  return hasContent ? JSON.stringify(trace) : undefined;
}
