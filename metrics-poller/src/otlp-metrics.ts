import type { CFMetricsResult } from './cf-graphql.js';

export interface OTLPMetricsConfig {
	LD_OTLP_METRICS_URL: string;
	LD_SDK_KEY: string;
	CF_ACCOUNT_ID: string;
}

export async function pushOTelMetrics(config: OTLPMetricsConfig, metrics: CFMetricsResult): Promise<void> {
	const now = Date.now() * 1_000_000;
	if (!config.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is required for metrics-poller');
	const accountId = config.CF_ACCOUNT_ID;

	// OTLP gauge data points encode numeric values as EITHER asInt (string-form
	// int64) or asDouble (JSON number). LD's ingester rejects asInt with a
	// ReadInt64 parse error if the string contains a decimal point, so any
	// non-integer (e.g. CF's totalNeurons = 12082.193518913959) MUST go through
	// asDouble. Integers stay on asInt to preserve int64 precision on the wire.
	const buildDataPoints = (kvPairs: { value: number; dims: Record<string, string> }[]) =>
		kvPairs.map((p) => {
			const attributes = Object.entries(p.dims).map(([key, value]) => ({ key, value: { stringValue: value } }));
			const isInt = Number.isInteger(p.value);
			return {
				attributes,
				timeUnixNano: String(now),
				...(isInt ? { asInt: String(p.value) } : { asDouble: p.value }),
			};
		});

	const d1Points = metrics.d1Storage.map((d) => ({
		value: d.sizeBytes,
		dims: { 'cf.binding_name': d.databaseName, 'cf.account_id': accountId },
	}));
	const kvPoints = metrics.kvStorage.map((k) => ({
		value: k.byteCount,
		dims: { 'cf.binding_name': k.namespaceName, 'cf.account_id': accountId },
	}));
	// AI metric naming reflects CF's published billing/usage semantics
	// (https://developers.cloudflare.com/workers-ai/platform/pricing/):
	//   - Neurons = authoritative monetization unit
	//   - Requests / inference-steps / tokens = operational signal alongside cost
	// The old `cf.ai.usage` was a vague stand-in built before the schema was
	// verified; it's renamed here to match the actual measured quantity.
	const aiNeuronPoints = metrics.aiUsage
		? [{ value: metrics.aiUsage.neurons, dims: { 'cf.account_id': accountId } }]
		: [];
	const aiInferenceStepPoints = metrics.aiUsage
		? [{ value: metrics.aiUsage.inferenceSteps, dims: { 'cf.account_id': accountId } }]
		: [];
	const aiInputTokenPoints = metrics.aiUsage
		? [{ value: metrics.aiUsage.inputTokens, dims: { 'cf.account_id': accountId } }]
		: [];
	const aiOutputTokenPoints = metrics.aiUsage
		? [{ value: metrics.aiUsage.outputTokens, dims: { 'cf.account_id': accountId } }]
		: [];
	const aiRequestPoints = metrics.aiUsage
		? [{ value: metrics.aiUsage.requests, dims: { 'cf.account_id': accountId } }]
		: [];

	// Day-to-date (UTC) billable counters — daily sawtooth by design, so an LD
	// panel's daily max IS the billing-relevant "per day" number. These are the
	// dimensions CF actually charges on (see docs/observability.md § dashboard
	// guide): D1 rows read/written, KV ops by action, DO requests.
	const d1RowsReadPoints = metrics.d1Analytics.map((d) => ({
		value: d.rowsRead,
		dims: { 'cf.binding_name': d.databaseName, 'cf.account_id': accountId },
	}));
	const d1RowsWrittenPoints = metrics.d1Analytics.map((d) => ({
		value: d.rowsWritten,
		dims: { 'cf.binding_name': d.databaseName, 'cf.account_id': accountId },
	}));
	const d1ReadQueriesPoints = metrics.d1Analytics.map((d) => ({
		value: d.readQueries,
		dims: { 'cf.binding_name': d.databaseName, 'cf.account_id': accountId },
	}));
	const d1WriteQueriesPoints = metrics.d1Analytics.map((d) => ({
		value: d.writeQueries,
		dims: { 'cf.binding_name': d.databaseName, 'cf.account_id': accountId },
	}));
	const kvOpsPoints = metrics.kvOperations.map((k) => ({
		value: k.requests,
		dims: { 'cf.binding_name': k.namespaceName, 'cf.kv.action': k.actionType, 'cf.account_id': accountId },
	}));
	const doRequestPoints = metrics.doUsage
		? [{ value: metrics.doUsage.requests, dims: { 'cf.account_id': accountId } }]
		: [];
	const doCpuPoints = metrics.doUsage
		? [{ value: metrics.doUsage.cpuTimeUs, dims: { 'cf.account_id': accountId } }]
		: [];
	const doStoredPoints = metrics.doUsage
		? [{ value: metrics.doUsage.storedBytes, dims: { 'cf.account_id': accountId } }]
		: [];

	// Previous-hour per-script Workers stats (datetime-granular dataset).
	// Requests are the billable count; CPU quantiles are the operational
	// signal for the CPU-ms billing dimension (a total isn't exposed).
	const workersPoint = (pick: (w: typeof metrics.workersHour[number]) => number) =>
		metrics.workersHour.map((w) => ({
			value: pick(w),
			dims: { 'cf.script_name': w.scriptName, 'cf.account_id': accountId },
		}));
	const workersRequestsPoints = workersPoint((w) => w.requests);
	const workersErrorsPoints = workersPoint((w) => w.errors);
	const workersSubrequestsPoints = workersPoint((w) => w.subrequests);
	const workersCpuP50Points = workersPoint((w) => w.cpuTimeP50Us);
	const workersCpuP99Points = workersPoint((w) => w.cpuTimeP99Us);

	// Day-to-date per-script Workers totals — daily-bar panels (stacked by
	// script, the stack height is the account total per day).
	const workersDayPoint = (pick: (w: typeof metrics.workersDay[number]) => number) =>
		metrics.workersDay.map((w) => ({
			value: pick(w),
			dims: { 'cf.script_name': w.scriptName, 'cf.account_id': accountId },
		}));
	const workersDayRequestsPoints = workersDayPoint((w) => w.requests);
	const workersDayErrorsPoints = workersDayPoint((w) => w.errors);
	const workersDaySubrequestsPoints = workersDayPoint((w) => w.subrequests);

	// Today's AI neurons — the free tier is per-day, so this is the number
	// the AI panel actually compares against 10k.
	const aiNeuronsTodayPoints = metrics.aiNeuronsToday !== null
		? [{ value: metrics.aiNeuronsToday, dims: { 'cf.account_id': accountId } }]
		: [];

	// The billing snapshot: one series per billable dimension, label carries
	// the quota — a single Table panel grouped by cf.billing.dimension IS the
	// month-to-date invoice preview.
	const billingMtdPoints = metrics.billingMtd.map((b) => ({
		value: b.value,
		dims: { 'cf.billing.dimension': b.dimension, 'cf.account_id': accountId },
	}));

	const payload = {
		resourceMetrics: [
			{
				resource: {
					attributes: [
						{ key: 'service.name', value: { stringValue: 'rf-cf-metrics-poller' } },
						{ key: 'launchdarkly.project_id', value: { stringValue: config.LD_SDK_KEY } },
						{ key: 'cloud.provider', value: { stringValue: 'cloudflare' } },
						{ key: 'cloud.platform', value: { stringValue: 'cloudflare.workers' } },
					],
				},
				scopeMetrics: [
					{
						scope: { name: 'rf-cf-metrics-poller', version: '0.1.0' },
						metrics: [
							{ name: 'cf.d1.storage_bytes', unit: 'By', gauge: { dataPoints: buildDataPoints(d1Points) } },
							{ name: 'cf.kv.stored_bytes', unit: 'By', gauge: { dataPoints: buildDataPoints(kvPoints) } },
							{ name: 'cf.ai.neurons', unit: '{neuron}', gauge: { dataPoints: buildDataPoints(aiNeuronPoints) } },
							{ name: 'cf.ai.inference_steps', unit: '{step}', gauge: { dataPoints: buildDataPoints(aiInferenceStepPoints) } },
							{ name: 'cf.ai.input_tokens', unit: '{token}', gauge: { dataPoints: buildDataPoints(aiInputTokenPoints) } },
							{ name: 'cf.ai.output_tokens', unit: '{token}', gauge: { dataPoints: buildDataPoints(aiOutputTokenPoints) } },
							{ name: 'cf.ai.requests', unit: '{request}', gauge: { dataPoints: buildDataPoints(aiRequestPoints) } },
							{ name: 'cf.d1.rows_read_day', unit: '{row}', gauge: { dataPoints: buildDataPoints(d1RowsReadPoints) } },
							{ name: 'cf.d1.rows_written_day', unit: '{row}', gauge: { dataPoints: buildDataPoints(d1RowsWrittenPoints) } },
							{ name: 'cf.d1.read_queries_day', unit: '{query}', gauge: { dataPoints: buildDataPoints(d1ReadQueriesPoints) } },
							{ name: 'cf.d1.write_queries_day', unit: '{query}', gauge: { dataPoints: buildDataPoints(d1WriteQueriesPoints) } },
							{ name: 'cf.kv.operations_day', unit: '{operation}', gauge: { dataPoints: buildDataPoints(kvOpsPoints) } },
							{ name: 'cf.do.requests_day', unit: '{request}', gauge: { dataPoints: buildDataPoints(doRequestPoints) } },
							{ name: 'cf.do.cpu_time_day_us', unit: 'us', gauge: { dataPoints: buildDataPoints(doCpuPoints) } },
							{ name: 'cf.do.stored_bytes', unit: 'By', gauge: { dataPoints: buildDataPoints(doStoredPoints) } },
							{ name: 'cf.workers.requests_hour', unit: '{request}', gauge: { dataPoints: buildDataPoints(workersRequestsPoints) } },
							{ name: 'cf.workers.errors_hour', unit: '{error}', gauge: { dataPoints: buildDataPoints(workersErrorsPoints) } },
							{ name: 'cf.workers.subrequests_hour', unit: '{subrequest}', gauge: { dataPoints: buildDataPoints(workersSubrequestsPoints) } },
							{ name: 'cf.workers.cpu_time_p50_us', unit: 'us', gauge: { dataPoints: buildDataPoints(workersCpuP50Points) } },
							{ name: 'cf.workers.cpu_time_p99_us', unit: 'us', gauge: { dataPoints: buildDataPoints(workersCpuP99Points) } },
							{ name: 'cf.workers.requests_day', unit: '{request}', gauge: { dataPoints: buildDataPoints(workersDayRequestsPoints) } },
							{ name: 'cf.workers.errors_day', unit: '{error}', gauge: { dataPoints: buildDataPoints(workersDayErrorsPoints) } },
							{ name: 'cf.workers.subrequests_day', unit: '{subrequest}', gauge: { dataPoints: buildDataPoints(workersDaySubrequestsPoints) } },
							{ name: 'cf.ai.neurons_day', unit: '{neuron}', gauge: { dataPoints: buildDataPoints(aiNeuronsTodayPoints) } },
							{ name: 'cf.billing.mtd', unit: '{unit}', gauge: { dataPoints: buildDataPoints(billingMtdPoints) } },
						],
					},
				],
			},
		],
	};

	let response: Response;
	try {
		response = await fetch(config.LD_OTLP_METRICS_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
	} catch (err) {
		console.error({
			source: 'metrics-poller',
			message: 'OTLP push failed (network)',
			error: String(err),
		});
		return;
	}
	if (!response.ok) {
		console.error({
			source: 'metrics-poller',
			message: 'OTLP push HTTP error',
			status: response.status,
		});
	}
}
