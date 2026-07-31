//! Parameter-bound SQL for the deterministic data path (design §5.4, §13).
//!
//! `sql-query` nodes never open a socket from the webview. The engine validates
//! the statement, evaluates the declared parameters and hands both to this
//! command together with the connection reference; Rust reads the connection
//! secrets out of the OS keychain, opens the connection and lets the **driver**
//! bind every value.
//!
//! Four invariants shape this module:
//!
//! 1. **A parameter is never statement text** (Requirement 10.4). `:name` is
//!    rewritten to the driver's own placeholder — `$1` for Postgres, `?` for
//!    MySQL and SQLite, `@P1` for SQL Server — and the value travels beside the
//!    statement. A payload of `'; DROP TABLE users; --` comes back as a string,
//!    because that is all the driver was ever told it was.
//! 2. **Secrets stay in Rust** (Requirement 3.3). Values are read through the
//!    chunked keychain path in [`crate::llm`] with the same complete-or-reject
//!    resolution [`crate::data`] uses, applied to the connection here, and
//!    scrubbed out of every row, column name and error message that crosses the
//!    IPC boundary back to the webview.
//! 3. **All three limits are applied to every statement** (Requirements 10.10,
//!    10.11, 10.14). Rows, result bytes and the statement timeout are resolved
//!    from the request, then the connection `limits`, then the defaults, with an
//!    out-of-range value falling through to the next tier rather than being
//!    clamped — the same tiering `resolveSqlLimits` performs in
//!    `engine/src/sql-statement.ts`. Reaching the row or byte cap stops the read
//!    and reports `truncated`; exceeding the timeout aborts the statement.
//! 4. **A pre-I/O rejection is not a transport failure** (Requirement 8.16). An
//!    unknown driver, a missing secret or a parameter that is not a scalar comes
//!    back as [`crate::data::KIND_CONFIG`]; only a call that actually reached a
//!    driver carries one of the six `TransportFailureKind` values, so the
//!    engine's retry classifier never retries a statement that was never sent.
//!
//! ## Connection shape
//!
//! Non-secret `Connection.config` entries, all optional unless noted:
//!
//! | key | drivers | meaning |
//! | --- | --- | --- |
//! | `host` | postgres, mysql, mssql | server host; required without a DSN secret |
//! | `port` | postgres, mysql, mssql | server port; defaults 5432 / 3306 / 1433 |
//! | `database` | all | database name; for `sqlite` the file path |
//! | `file`, `path` | sqlite | file path, preferred over `database` |
//! | `user`, `username` | postgres, mysql, mssql | login name when it is not a secret |
//! | `sslMode` | postgres, mysql | `disable`/`prefer`/`require`/`verify-ca`/`verify-full` |
//! | `instance` | mssql | named instance |
//! | `trustServerCertificate` | mssql | `true` accepts the server certificate unverified |
//!
//! Secret keys, resolved from the keychain and never returned:
//!
//! | key | meaning |
//! | --- | --- |
//! | `dsn`, `url`, `connectionString` | full connection string; wins over the config entries above |
//! | `user`, `username` | login name |
//! | `password`, `pass` | password |

use std::{
    collections::{BTreeSet, HashMap},
    error::Error as StdError,
    str::FromStr,
    time::{Duration, Instant},
};

use futures_util::{Stream, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value};

use crate::data::{config_error, resolve_secrets, scrub, transport_error, DataErrorDto};

// ─────────────────────────────────────────────────────────────────────────────
// Limits (Requirement 10.10)
// ─────────────────────────────────────────────────────────────────────────────

/// Rows returned when neither the request nor the connection sets a cap.
const DEFAULT_MAX_ROWS: u64 = 10_000;
/// Result bytes read when neither the request nor the connection sets a cap.
const DEFAULT_MAX_RESULT_BYTES: u64 = 4 * 1024 * 1024;
/// Statement timeout when neither the request nor the connection sets one.
const DEFAULT_STATEMENT_TIMEOUT_MS: u64 = 30_000;

/// Inclusive accepted ranges, mirroring `SQL_LIMIT_RANGES` in
/// `engine/src/sql-statement.ts`. A value outside its range is ignored, not
/// clamped, so stale node data cannot silently turn into a different limit.
const MAX_ROWS_RANGE: (i64, i64) = (1, 1_000_000);
const MAX_RESULT_BYTES_RANGE: (i64, i64) = (1_024, 33_554_432);
const STATEMENT_TIMEOUT_MS_RANGE: (i64, i64) = (1_000, 300_000);

/// Longest accepted statement, mirroring `MAX_SQL_STATEMENT_LENGTH`.
const MAX_STATEMENT_CHARS: usize = 20_000;
/// Most bound parameters one statement may carry, mirroring `MAX_SQL_PARAMETERS`.
const MAX_PARAMETERS: usize = 64;
/// Longest accepted parameter name, from `SQL_PARAM_NAME_PATTERN`.
const MAX_PARAM_NAME_CHARS: usize = 64;

/// Host label named in a rejection, mirroring the desktop capability record.
const HOST_LABEL: &str = "Phorma Agent Studio desktop";

// ─────────────────────────────────────────────────────────────────────────────
// IPC data transfer objects
// ─────────────────────────────────────────────────────────────────────────────

/// One parameterised statement, mirroring `SqlRequest` in
/// `engine/src/data-host.ts`. Carries no credential: the connection supplies it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRequestDto {
    pub driver: String,
    pub statement: String,
    /// Parameter name to scalar value. Only strings, numbers, booleans and null
    /// are bindable; anything else is rejected before a connection is opened.
    #[serde(default)]
    pub params: HashMap<String, Value>,
    /// Non-secret `ResolvedConnection.config`.
    #[serde(default)]
    pub config: HashMap<String, String>,
    /// `ResolvedConnection.limits`, the second resolution tier.
    #[serde(default)]
    pub limits: Option<SqlLimitsDto>,
    #[serde(default)]
    pub max_rows: Option<i64>,
    #[serde(default)]
    pub max_result_bytes: Option<i64>,
    #[serde(default)]
    pub statement_timeout_ms: Option<i64>,
}

/// `SqlLimits` in `engine/src/connections.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlLimitsDto {
    #[serde(default)]
    pub max_rows: Option<i64>,
    #[serde(default)]
    pub max_result_bytes: Option<i64>,
    #[serde(default)]
    pub statement_timeout_ms: Option<i64>,
}

/// One column of a result, mirroring `SqlResult.columns`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SqlColumnDto {
    pub name: String,
    /// Driver-reported type name, powering the "Test query" affordance.
    #[serde(rename = "type")]
    pub type_name: String,
}

/// The answer to a [`SqlRequestDto`], mirroring `SqlResult`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlResultDto {
    /// One JSON object per row, column name to value.
    pub rows: Vec<Value>,
    pub row_count: u64,
    /// True when `maxRows` or `maxResultBytes` stopped the read
    /// (Requirement 10.11).
    pub truncated: bool,
    pub columns: Vec<SqlColumnDto>,
    pub duration_ms: u64,
}

/// The three limits actually applied to a statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EffectiveLimits {
    pub max_rows: u64,
    pub max_result_bytes: u64,
    pub statement_timeout_ms: u64,
}

/// Driver families this host can execute, mirroring `SqlDriver`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Driver {
    Postgres,
    MySql,
    MsSql,
    Sqlite,
}

impl Driver {
    fn parse(driver: &str) -> Result<Self, DataErrorDto> {
        match driver.trim().to_ascii_lowercase().as_str() {
            "postgres" => Ok(Self::Postgres),
            "mysql" => Ok(Self::MySql),
            "mssql" => Ok(Self::MsSql),
            "sqlite" => Ok(Self::Sqlite),
            other => Err(config_error(format!(
                "The {HOST_LABEL} host cannot execute the SQL driver \"{other}\": expected one of postgres, mysql, mssql, sqlite."
            ))),
        }
    }

    /// Placeholder dialect the driver binds by.
    fn placeholders(self) -> Placeholders {
        match self {
            Self::Postgres => Placeholders::Dollar,
            Self::MySql | Self::Sqlite => Placeholders::Question,
            Self::MsSql => Placeholders::AtP,
        }
    }
}

/// How a `:name` parameter is spelled once the driver owns the binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placeholders {
    /// `$1`, reused for a repeated name (Postgres).
    Dollar,
    /// `?`, one bind per occurrence (MySQL, SQLite).
    Question,
    /// `@P1`, reused for a repeated name (SQL Server).
    AtP,
}

/// One value as the driver will bind it.
#[derive(Debug, Clone, PartialEq)]
enum Bound {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

/// A statement rewritten into driver placeholders, with the values in bind order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Prepared {
    sql: String,
    binds: Vec<Bound>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

/// Executes one parameterised statement, resolving the connection secrets
/// inside Rust and letting the driver bind every parameter.
///
/// # Errors
///
/// Returns a [`DataErrorDto`] whose `kind` is [`crate::data::KIND_CONFIG`] when
/// the call was rejected before any connection was opened, and one of the six
/// transport kinds when a driver failed. The `message`, the rows and the column
/// names contain no secret value, in whole or as a substring.
#[tauri::command]
pub async fn sql_query(
    connection_id: Option<String>,
    secret_keys: Vec<String>,
    request: SqlRequestDto,
) -> Result<SqlResultDto, DataErrorDto> {
    let connection_id = connection_id.unwrap_or_default();
    // Complete-or-reject: every declared secret is read before a connection is
    // opened, so a statement can never run half-authenticated (Requirement 2.3).
    let secrets = resolve_secrets(&connection_id, &secret_keys)?;
    let values: Vec<String> = secrets.values().cloned().collect();

    match execute(&request, &secrets).await {
        Ok(mut result) => {
            for row in &mut result.rows {
                scrub_value(row, &values);
            }
            for column in &mut result.columns {
                column.name = scrub(&column.name, &values);
            }
            Ok(result)
        }
        Err(error) => Err(DataErrorDto {
            kind: error.kind,
            message: scrub(&error.message, &values),
        }),
    }
}

/// Prepares and runs one statement under the effective limits.
///
/// Separated from the command so the driver paths are reachable from tests
/// without a Tauri runtime and without a keychain.
pub(crate) async fn execute(
    request: &SqlRequestDto,
    secrets: &HashMap<String, String>,
) -> Result<SqlResultDto, DataErrorDto> {
    let driver = Driver::parse(&request.driver)?;
    let limits = resolve_limits(request);
    let prepared = prepare(&request.statement, &request.params, driver.placeholders())?;

    let budget = Duration::from_millis(limits.statement_timeout_ms);
    let started = Instant::now();
    // One budget covering connect, execute and row read. Dropping the driver
    // future closes the connection, which is what aborts the statement server
    // side (Requirement 10.14).
    let outcome = tokio::time::timeout(
        budget,
        run(driver, &prepared, &request.config, secrets, limits),
    )
    .await;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let collected = match outcome {
        Err(_) => {
            return Err(transport_error(
                "timeout",
                format!(
                    "The statement did not complete within the effective statementTimeoutMs of {} ms and was aborted.",
                    limits.statement_timeout_ms
                ),
            ))
        }
        Ok(result) => result?,
    };

    Ok(SqlResultDto {
        row_count: collected.rows.len() as u64,
        rows: collected.rows,
        truncated: collected.truncated,
        columns: collected.columns,
        duration_ms,
    })
}

/// Dispatches to the driver family.
async fn run(
    driver: Driver,
    prepared: &Prepared,
    config: &HashMap<String, String>,
    secrets: &HashMap<String, String>,
    limits: EffectiveLimits,
) -> Result<Collected, DataErrorDto> {
    match driver {
        Driver::Postgres => run_postgres(prepared, config, secrets, limits).await,
        Driver::MySql => run_mysql(prepared, config, secrets, limits).await,
        Driver::Sqlite => run_sqlite(prepared, config, limits).await,
        Driver::MsSql => run_mssql(prepared, config, secrets, limits).await,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Limit resolution (Requirement 10.10)
// ─────────────────────────────────────────────────────────────────────────────

/// Resolves each limit from the request, then the connection `limits`, then the
/// default, independently per limit.
pub(crate) fn resolve_limits(request: &SqlRequestDto) -> EffectiveLimits {
    let connection = request.limits.clone().unwrap_or_default();
    EffectiveLimits {
        max_rows: pick_limit(
            &[request.max_rows, connection.max_rows],
            MAX_ROWS_RANGE,
            DEFAULT_MAX_ROWS,
        ),
        max_result_bytes: pick_limit(
            &[request.max_result_bytes, connection.max_result_bytes],
            MAX_RESULT_BYTES_RANGE,
            DEFAULT_MAX_RESULT_BYTES,
        ),
        statement_timeout_ms: pick_limit(
            &[request.statement_timeout_ms, connection.statement_timeout_ms],
            STATEMENT_TIMEOUT_MS_RANGE,
            DEFAULT_STATEMENT_TIMEOUT_MS,
        ),
    }
}

/// Picks the first tier inside the accepted range; an out-of-range value falls
/// through to the next tier rather than clamping, mirroring `pickLimit`.
fn pick_limit(tiers: &[Option<i64>], range: (i64, i64), fallback: u64) -> u64 {
    for tier in tiers {
        if let Some(value) = *tier {
            if value >= range.0 && value <= range.1 {
                return u64::try_from(value).unwrap_or(fallback);
            }
        }
    }
    fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Statement preparation (Requirement 10.4)
// ─────────────────────────────────────────────────────────────────────────────

fn is_word_char(char: char) -> bool {
    char.is_ascii_alphanumeric() || char == '_' || char == '$'
}

/// Rewrites every `:name` outside a literal or a comment into the driver's own
/// placeholder and collects the values in bind order.
///
/// The literal, quoted-identifier and comment skipping mirrors `maskSqlText` in
/// `engine/src/sql-statement.ts` so both sides agree on which `:name` tokens are
/// parameters: `select ':not_a_param'` binds nothing, `id::text` is a cast, and
/// `array[1:2]` is a range.
///
/// # Errors
///
/// Rejects an empty or over-long statement, a name with no value, a value that
/// is not a scalar, and a value that no `:name` in the statement uses — the last
/// one because a parameter the driver never binds is a spec mismatch, not a
/// harmless extra.
pub(crate) fn prepare(
    statement: &str,
    params: &HashMap<String, Value>,
    style: Placeholders,
) -> Result<Prepared, DataErrorDto> {
    if statement.trim().is_empty() {
        return Err(config_error(
            "SQL statement is empty; there is nothing to execute.",
        ));
    }
    let chars: Vec<char> = statement.chars().collect();
    if chars.len() > MAX_STATEMENT_CHARS {
        return Err(config_error(format!(
            "SQL statement is {} characters; the limit is {MAX_STATEMENT_CHARS}.",
            chars.len()
        )));
    }
    if params.len() > MAX_PARAMETERS {
        return Err(config_error(format!(
            "SQL statement binds {} parameters; the limit is {MAX_PARAMETERS}.",
            params.len()
        )));
    }

    let mut sql = String::with_capacity(statement.len() + 16);
    let mut binds: Vec<Bound> = Vec::new();
    let mut indexes: HashMap<String, usize> = HashMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let total = chars.len();
    let mut index = 0;

    while index < total {
        let current = chars[index];
        let next = chars.get(index + 1).copied();

        // `-- …` to end of line.
        if current == '-' && next == Some('-') {
            while index < total && chars[index] != '\n' {
                sql.push(chars[index]);
                index += 1;
            }
            continue;
        }

        // `/* … */`, nestable as Postgres allows.
        if current == '/' && next == Some('*') {
            let mut depth = 0_i32;
            while index < total {
                if chars[index] == '/' && chars.get(index + 1) == Some(&'*') {
                    sql.push('/');
                    sql.push('*');
                    depth += 1;
                    index += 2;
                    continue;
                }
                if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
                    sql.push('*');
                    sql.push('/');
                    depth -= 1;
                    index += 2;
                    if depth <= 0 {
                        break;
                    }
                    continue;
                }
                sql.push(chars[index]);
                index += 1;
            }
            continue;
        }

        // `'…'`, `"…"` and `` `…` ``, with the doubled-delimiter escape.
        if current == '\'' || current == '"' || current == '`' {
            index = copy_delimited(&chars, index, current, current, &mut sql);
            continue;
        }

        // `[…]` bracketed identifiers (SQL Server), with the `]]` escape.
        if current == '[' {
            index = copy_delimited(&chars, index, '[', ']', &mut sql);
            continue;
        }

        if current != ':' {
            sql.push(current);
            index += 1;
            continue;
        }

        // `::` is a cast, never a parameter.
        if next == Some(':') {
            sql.push_str("::");
            index += 2;
            continue;
        }
        // A colon glued to the right of a word is a range or an assignment.
        if index > 0 && is_word_char(chars[index - 1]) {
            sql.push(':');
            index += 1;
            continue;
        }

        let start = index + 1;
        let mut end = start;
        while end < total && is_word_char(chars[end]) {
            end += 1;
        }
        let opens_a_name = end > start && !chars[start].is_ascii_digit();
        if !opens_a_name {
            sql.push(':');
            index += 1;
            continue;
        }

        let name: String = chars[start..end].iter().collect();
        if name.chars().count() > MAX_PARAM_NAME_CHARS {
            return Err(config_error(format!(
                "SQL parameter \":{name}\" is longer than {MAX_PARAM_NAME_CHARS} characters and cannot be bound."
            )));
        }
        let Some(value) = params.get(&name) else {
            return Err(config_error(format!(
                "SQL statement uses the parameter \":{name}\", for which no value was bound."
            )));
        };
        let bound = bind_value(&name, value)?;
        seen.insert(name.clone());

        match style {
            Placeholders::Question => {
                sql.push('?');
                binds.push(bound);
            }
            Placeholders::Dollar | Placeholders::AtP => {
                let position = match indexes.get(&name) {
                    Some(position) => *position,
                    None => {
                        binds.push(bound);
                        let position = binds.len();
                        indexes.insert(name.clone(), position);
                        position
                    }
                };
                if style == Placeholders::Dollar {
                    sql.push('$');
                } else {
                    sql.push_str("@P");
                }
                sql.push_str(&position.to_string());
            }
        }
        index = end;
    }

    let unused: Vec<String> = params
        .keys()
        .filter(|name| !seen.contains(*name))
        .cloned()
        .collect();
    if !unused.is_empty() {
        let mut unused = unused;
        unused.sort();
        return Err(config_error(format!(
            "SQL parameters do not match the statement — bound but absent from the statement: {}.",
            unused.join(", ")
        )));
    }

    Ok(Prepared { sql, binds })
}

/// Copies a delimited run verbatim, honouring the doubled-delimiter escape, and
/// returns the index just past it.
fn copy_delimited(
    chars: &[char],
    start: usize,
    open: char,
    close: char,
    out: &mut String,
) -> usize {
    let total = chars.len();
    out.push(open);
    let mut index = start + 1;
    while index < total {
        if chars[index] == close {
            out.push(close);
            index += 1;
            if index < total && chars[index] == close {
                out.push(close);
                index += 1;
                continue;
            }
            return index;
        }
        out.push(chars[index]);
        index += 1;
    }
    index
}

/// Turns one JSON value into a bindable scalar, naming the parameter and the
/// rejected kind for anything else (Requirement 10.13's host-side counterpart).
fn bind_value(name: &str, value: &Value) -> Result<Bound, DataErrorDto> {
    match value {
        Value::Null => Ok(Bound::Null),
        Value::Bool(flag) => Ok(Bound::Bool(*flag)),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                Ok(Bound::Int(int))
            } else if let Some(float) = number.as_f64() {
                Ok(Bound::Float(float))
            } else {
                Err(config_error(format!(
                    "SQL parameter \"{name}\" is a number outside the bindable range."
                )))
            }
        }
        Value::String(text) => Ok(Bound::Text(text.clone())),
        Value::Array(_) => Err(config_error(format!(
            "SQL parameter \"{name}\" is an array; only a string, number, boolean or null can be bound."
        ))),
        Value::Object(_) => Err(config_error(format!(
            "SQL parameter \"{name}\" is an object; only a string, number, boolean or null can be bound."
        ))),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row collection under the row and byte caps (Requirement 10.11)
// ─────────────────────────────────────────────────────────────────────────────

/// Rows read from one statement, with the columns and the truncation verdict.
#[derive(Debug, Clone, Default)]
pub(crate) struct Collected {
    rows: Vec<Value>,
    columns: Vec<SqlColumnDto>,
    truncated: bool,
}

/// Accumulates rows until the row cap or the byte cap is reached.
///
/// `truncated` is set only when a further row actually existed: the row cap is
/// tested after the next row has been pulled off the stream, so a result of
/// exactly `maxRows` rows is complete, not truncated.
fn accumulate(
    collected: &mut Collected,
    bytes: &mut u64,
    object: JsonMap<String, Value>,
    limits: EffectiveLimits,
) -> bool {
    if collected.rows.len() as u64 >= limits.max_rows {
        collected.truncated = true;
        return false;
    }
    let size = serde_json::to_string(&object).map_or(0, |text| text.len() as u64);
    let first = collected.rows.is_empty();
    if bytes.saturating_add(size) > limits.max_result_bytes {
        collected.truncated = true;
        // A single over-sized row is still returned: an empty result would read
        // as "no data" rather than "your cap is smaller than one row".
        if !first {
            return false;
        }
        *bytes = size;
        collected.rows.push(Value::Object(object));
        return false;
    }
    *bytes += size;
    collected.rows.push(Value::Object(object));
    true
}

/// Drains an sqlx row stream under the effective limits.
async fn collect_sqlx<S, R, C, V>(
    mut stream: S,
    limits: EffectiveLimits,
    columns_of: C,
    object_of: V,
) -> Result<Collected, DataErrorDto>
where
    S: Stream<Item = Result<R, sqlx::Error>> + Unpin,
    C: Fn(&R) -> Vec<SqlColumnDto>,
    V: Fn(&R) -> JsonMap<String, Value>,
{
    let mut collected = Collected::default();
    let mut bytes = 0_u64;
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|error| classify_sqlx(Phase::Execute, &error))?
    {
        if collected.columns.is_empty() {
            collected.columns = columns_of(&row);
        }
        if !accumulate(&mut collected, &mut bytes, object_of(&row), limits) {
            break;
        }
    }
    Ok(collected)
}

// ─────────────────────────────────────────────────────────────────────────────
// Value decoding
// ─────────────────────────────────────────────────────────────────────────────

/// Decodes one column by trying the driver's own decoders in order, stopping at
/// the first type the column is compatible with.
///
/// Type-name matching would need a table per driver and would still fall back to
/// something; asking the driver "can this column be read as `T`" reuses the
/// decoders sqlx already ships and keeps the four families on one shape.
macro_rules! decode_chain {
    ($row:expr, $index:expr, $( $ty:ty => $conv:expr ),+ $(,)?) => {{
        let mut decoded: Option<Value> = None;
        $(
            if decoded.is_none() {
                if let Ok(value) = sqlx::Row::try_get::<Option<$ty>, _>($row, $index) {
                    decoded = Some(value.map_or(Value::Null, $conv));
                }
            }
        )+
        decoded.unwrap_or(Value::Null)
    }};
}

/// Binds every value of a prepared statement in order. Shared by the three sqlx
/// drivers, which all accept the four scalar shapes.
macro_rules! bind_all {
    ($query:expr, $binds:expr) => {{
        let mut query = $query;
        for bound in $binds {
            query = match bound {
                Bound::Null => query.bind(Option::<String>::None),
                Bound::Bool(flag) => query.bind(*flag),
                Bound::Int(int) => query.bind(*int),
                Bound::Float(float) => query.bind(*float),
                Bound::Text(text) => query.bind(text.clone()),
            };
        }
        query
    }};
}

/// Column names and driver-reported type names, in result order.
fn columns_of<R>(row: &R) -> Vec<SqlColumnDto>
where
    R: sqlx::Row,
{
    use sqlx::{Column, TypeInfo};
    row.columns()
        .iter()
        .map(|column| SqlColumnDto {
            name: column.name().to_owned(),
            type_name: column.type_info().name().to_owned(),
        })
        .collect()
}

fn iso_naive_date_time(value: sqlx::types::chrono::NaiveDateTime) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.f").to_string())
}

fn postgres_object(row: &sqlx::postgres::PgRow) -> JsonMap<String, Value> {
    use sqlx::types::{
        chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc},
        BigDecimal, Uuid,
    };
    let mut object = JsonMap::new();
    for (index, column) in sqlx::Row::columns(row).iter().enumerate() {
        let value = decode_chain!(
            row, index,
            i64 => Value::from,
            i32 => Value::from,
            i16 => Value::from,
            f64 => Value::from,
            f32 => Value::from,
            bool => Value::Bool,
            String => Value::String,
            Value => |value: Value| value,
            DateTime<Utc> => |value: DateTime<Utc>| Value::String(value.to_rfc3339()),
            NaiveDateTime => iso_naive_date_time,
            NaiveDate => |value: NaiveDate| Value::String(value.to_string()),
            NaiveTime => |value: NaiveTime| Value::String(value.to_string()),
            BigDecimal => |value: BigDecimal| Value::String(value.to_string()),
            Uuid => |value: Uuid| Value::String(value.to_string()),
            Vec<u8> => |value: Vec<u8>| Value::String(crate::data::base64_encode(&value)),
        );
        object.insert(sqlx::Column::name(column).to_owned(), value);
    }
    object
}

fn mysql_object(row: &sqlx::mysql::MySqlRow) -> JsonMap<String, Value> {
    use sqlx::types::{
        chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc},
        BigDecimal,
    };
    let mut object = JsonMap::new();
    for (index, column) in sqlx::Row::columns(row).iter().enumerate() {
        let value = decode_chain!(
            row, index,
            i64 => Value::from,
            u64 => Value::from,
            i32 => Value::from,
            f64 => Value::from,
            f32 => Value::from,
            bool => Value::Bool,
            String => Value::String,
            Value => |value: Value| value,
            DateTime<Utc> => |value: DateTime<Utc>| Value::String(value.to_rfc3339()),
            NaiveDateTime => iso_naive_date_time,
            NaiveDate => |value: NaiveDate| Value::String(value.to_string()),
            NaiveTime => |value: NaiveTime| Value::String(value.to_string()),
            BigDecimal => |value: BigDecimal| Value::String(value.to_string()),
            Vec<u8> => |value: Vec<u8>| Value::String(crate::data::base64_encode(&value)),
        );
        object.insert(sqlx::Column::name(column).to_owned(), value);
    }
    object
}

fn sqlite_object(row: &sqlx::sqlite::SqliteRow) -> JsonMap<String, Value> {
    use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    let mut object = JsonMap::new();
    for (index, column) in sqlx::Row::columns(row).iter().enumerate() {
        let value = decode_chain!(
            row, index,
            i64 => Value::from,
            f64 => Value::from,
            bool => Value::Bool,
            String => Value::String,
            DateTime<Utc> => |value: DateTime<Utc>| Value::String(value.to_rfc3339()),
            NaiveDateTime => iso_naive_date_time,
            NaiveDate => |value: NaiveDate| Value::String(value.to_string()),
            NaiveTime => |value: NaiveTime| Value::String(value.to_string()),
            Vec<u8> => |value: Vec<u8>| Value::String(crate::data::base64_encode(&value)),
        );
        object.insert(sqlx::Column::name(column).to_owned(), value);
    }
    object
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection details from config and secrets
// ─────────────────────────────────────────────────────────────────────────────

/// Secret keys that may carry a whole connection string.
const DSN_SECRET_KEYS: [&str; 3] = ["dsn", "connectionString", "url"];
/// Secret keys that may carry the login name.
const USER_SECRET_KEYS: [&str; 2] = ["user", "username"];
/// Secret keys that may carry the password.
const PASSWORD_SECRET_KEYS: [&str; 2] = ["password", "pass"];

fn first_present<'a>(
    map: &'a HashMap<String, String>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        map.get(*key)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    })
}

fn config_entry<'a>(config: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    config
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

fn require_host<'a>(config: &'a HashMap<String, String>) -> Result<&'a str, DataErrorDto> {
    config_entry(config, "host").ok_or_else(|| {
        config_error(
            "This SQL connection declares no host. Set the connection's host, or store a dsn secret.",
        )
    })
}

fn port_or(config: &HashMap<String, String>, default: u16) -> Result<u16, DataErrorDto> {
    match config_entry(config, "port") {
        None => Ok(default),
        Some(text) => text.parse::<u16>().map_err(|_| {
            config_error(format!(
                "This SQL connection declares the port \"{text}\", which is not a port number."
            ))
        }),
    }
}

/// Login name: a secret first, then the non-secret config.
fn login_user(
    config: &HashMap<String, String>,
    secrets: &HashMap<String, String>,
) -> Option<String> {
    first_present(secrets, &USER_SECRET_KEYS)
        .map(str::to_owned)
        .or_else(|| {
            USER_SECRET_KEYS
                .iter()
                .find_map(|key| config_entry(config, key))
                .map(str::to_owned)
        })
}

/// SQLite database file: `file`, then `path`, then `database`.
fn sqlite_path(config: &HashMap<String, String>) -> Result<String, DataErrorDto> {
    ["file", "path", "database"]
        .iter()
        .find_map(|key| config_entry(config, key))
        .map(str::to_owned)
        .ok_or_else(|| {
            config_error(
                "This SQLite connection declares no database file. Set the connection's file path.",
            )
        })
}

fn postgres_ssl_mode(mode: &str) -> Result<sqlx::postgres::PgSslMode, DataErrorDto> {
    use sqlx::postgres::PgSslMode;
    match mode.trim().to_ascii_lowercase().as_str() {
        "disable" | "disabled" | "off" => Ok(PgSslMode::Disable),
        "allow" => Ok(PgSslMode::Allow),
        "prefer" => Ok(PgSslMode::Prefer),
        "require" | "required" => Ok(PgSslMode::Require),
        "verify-ca" | "verify_ca" => Ok(PgSslMode::VerifyCa),
        "verify-full" | "verify_full" => Ok(PgSslMode::VerifyFull),
        other => Err(config_error(format!(
            "This SQL connection declares the sslMode \"{other}\": expected disable, allow, prefer, require, verify-ca or verify-full."
        ))),
    }
}

fn mysql_ssl_mode(mode: &str) -> Result<sqlx::mysql::MySqlSslMode, DataErrorDto> {
    use sqlx::mysql::MySqlSslMode;
    match mode.trim().to_ascii_lowercase().as_str() {
        "disable" | "disabled" | "off" => Ok(MySqlSslMode::Disabled),
        "allow" | "prefer" | "preferred" => Ok(MySqlSslMode::Preferred),
        "require" | "required" => Ok(MySqlSslMode::Required),
        "verify-ca" | "verify_ca" => Ok(MySqlSslMode::VerifyCa),
        "verify-full" | "verify_full" | "verify-identity" => Ok(MySqlSslMode::VerifyIdentity),
        other => Err(config_error(format!(
            "This SQL connection declares the sslMode \"{other}\": expected disable, prefer, require, verify-ca or verify-full."
        ))),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drivers
// ─────────────────────────────────────────────────────────────────────────────

/// Postgres, through the driver's own `$n` binding.
async fn run_postgres(
    prepared: &Prepared,
    config: &HashMap<String, String>,
    secrets: &HashMap<String, String>,
    limits: EffectiveLimits,
) -> Result<Collected, DataErrorDto> {
    use sqlx::{postgres::PgConnectOptions, Connection, PgConnection};

    let mut options = match first_present(secrets, &DSN_SECRET_KEYS) {
        Some(dsn) => PgConnectOptions::from_str(dsn).map_err(|_| {
            config_error("The stored connection string is not a valid Postgres DSN.")
        })?,
        None => {
            let mut options = PgConnectOptions::new()
                .host(require_host(config)?)
                .port(port_or(config, 5432)?);
            if let Some(database) = config_entry(config, "database") {
                options = options.database(database);
            }
            if let Some(user) = login_user(config, secrets) {
                options = options.username(&user);
            }
            if let Some(password) = first_present(secrets, &PASSWORD_SECRET_KEYS) {
                options = options.password(password);
            }
            if let Some(mode) = config_entry(config, "sslMode") {
                options = options.ssl_mode(postgres_ssl_mode(mode)?);
            }
            options
        }
    };
    options = options.application_name("phorma-agent-studio");

    let mut connection = PgConnection::connect_with(&options)
        .await
        .map_err(|error| classify_sqlx(Phase::Connect, &error))?;
    // Server-side counterpart of the client budget: best effort, because a
    // pooler may refuse the SET without the statement itself being unrunnable.
    let _ = sqlx::query(&format!(
        "SET statement_timeout = {}",
        limits.statement_timeout_ms
    ))
    .execute(&mut connection)
    .await;

    let query = bind_all!(
        sqlx::query::<sqlx::Postgres>(prepared.sql.as_str()),
        &prepared.binds
    );
    collect_sqlx(
        query.fetch(&mut connection),
        limits,
        columns_of,
        postgres_object,
    )
    .await
}

/// MySQL and MariaDB, through the driver's own `?` binding.
async fn run_mysql(
    prepared: &Prepared,
    config: &HashMap<String, String>,
    secrets: &HashMap<String, String>,
    limits: EffectiveLimits,
) -> Result<Collected, DataErrorDto> {
    use sqlx::{mysql::MySqlConnectOptions, Connection, MySqlConnection};

    let options = match first_present(secrets, &DSN_SECRET_KEYS) {
        Some(dsn) => MySqlConnectOptions::from_str(dsn).map_err(|_| {
            config_error("The stored connection string is not a valid MySQL DSN.")
        })?,
        None => {
            let mut options = MySqlConnectOptions::new()
                .host(require_host(config)?)
                .port(port_or(config, 3306)?);
            if let Some(database) = config_entry(config, "database") {
                options = options.database(database);
            }
            if let Some(user) = login_user(config, secrets) {
                options = options.username(&user);
            }
            if let Some(password) = first_present(secrets, &PASSWORD_SECRET_KEYS) {
                options = options.password(password);
            }
            if let Some(mode) = config_entry(config, "sslMode") {
                options = options.ssl_mode(mysql_ssl_mode(mode)?);
            }
            options
        }
    };

    let mut connection = MySqlConnection::connect_with(&options)
        .await
        .map_err(|error| classify_sqlx(Phase::Connect, &error))?;
    // MySQL 5.7 and later only, and SELECT only; the client budget covers the
    // rest, so a server that does not know the variable is not an error here.
    let _ = sqlx::query(&format!(
        "SET SESSION max_execution_time = {}",
        limits.statement_timeout_ms
    ))
    .execute(&mut connection)
    .await;

    let query = bind_all!(
        sqlx::query::<sqlx::MySql>(prepared.sql.as_str()),
        &prepared.binds
    );
    collect_sqlx(
        query.fetch(&mut connection),
        limits,
        columns_of,
        mysql_object,
    )
    .await
}

/// SQLite, through the driver's own `?` binding.
///
/// The database file must already exist: a `sql-query` node reads or writes a
/// database an operator configured, and quietly creating an empty one would turn
/// a typo into a run that succeeds against nothing. `:memory:` is accepted for a
/// scratch database that never touches disk.
async fn run_sqlite(
    prepared: &Prepared,
    config: &HashMap<String, String>,
    limits: EffectiveLimits,
) -> Result<Collected, DataErrorDto> {
    use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};

    let path = sqlite_path(config)?;
    let in_memory = matches!(
        path.as_str(),
        ":memory:" | "sqlite::memory:" | "file::memory:"
    );
    let options = SqliteConnectOptions::new()
        .filename(if in_memory { ":memory:" } else { path.as_str() })
        .in_memory(in_memory)
        .create_if_missing(in_memory)
        .busy_timeout(Duration::from_millis(limits.statement_timeout_ms));

    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| classify_sqlx(Phase::Connect, &error))?;

    let query = bind_all!(
        sqlx::query::<sqlx::Sqlite>(prepared.sql.as_str()),
        &prepared.binds
    );
    collect_sqlx(
        query.fetch(&mut connection),
        limits,
        columns_of,
        sqlite_object,
    )
    .await
}

/// SQL Server over TDS, through the driver's own `@Pn` binding.
async fn run_mssql(
    prepared: &Prepared,
    config: &HashMap<String, String>,
    secrets: &HashMap<String, String>,
    limits: EffectiveLimits,
) -> Result<Collected, DataErrorDto> {
    use tiberius::{AuthMethod, Client, Config, ToSql};
    use tokio_util::compat::TokioAsyncWriteCompatExt;

    let mut tds = match first_present(secrets, &DSN_SECRET_KEYS) {
        Some(ado) => Config::from_ado_string(ado).map_err(|_| {
            config_error("The stored connection string is not a valid SQL Server connection string.")
        })?,
        None => {
            let mut tds = Config::new();
            tds.host(require_host(config)?);
            tds.port(port_or(config, 1433)?);
            if let Some(database) = config_entry(config, "database") {
                tds.database(database);
            }
            if let Some(instance) = config_entry(config, "instance") {
                tds.instance_name(instance);
            }
            let Some(user) = login_user(config, secrets) else {
                return Err(config_error(
                    "This SQL Server connection declares no login name. Set the connection's user, or store a dsn secret.",
                ));
            };
            let password = first_present(secrets, &PASSWORD_SECRET_KEYS).unwrap_or_default();
            tds.authentication(AuthMethod::sql_server(&user, password));
            tds
        }
    };
    tds.application_name("phorma-agent-studio");
    if config_entry(config, "trustServerCertificate")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        tds.trust_cert();
    }

    let stream = tokio::net::TcpStream::connect(tds.get_addr())
        .await
        .map_err(|error| classify_error(Phase::Connect, &error, "connect to SQL Server"))?;
    let _ = stream.set_nodelay(true);
    let mut client = Client::connect(tds, stream.compat_write())
        .await
        .map_err(|error| classify_error(Phase::Connect, &error, "connect to SQL Server"))?;

    let owned: Vec<Box<dyn ToSql>> = prepared.binds.iter().map(mssql_param).collect();
    let params: Vec<&dyn ToSql> = owned.iter().map(|param| &**param).collect();

    let results = client
        .query(prepared.sql.as_str(), &params)
        .await
        .map_err(|error| classify_error(Phase::Execute, &error, "run the statement"))?;

    let mut rows = results.into_row_stream();
    let mut collected = Collected::default();
    let mut bytes = 0_u64;
    while let Some(row) = rows
        .try_next()
        .await
        .map_err(|error| classify_error(Phase::Execute, &error, "read the result"))?
    {
        if collected.columns.is_empty() {
            collected.columns = mssql_columns(&row);
        }
        if !accumulate(&mut collected, &mut bytes, mssql_object(&row), limits) {
            break;
        }
    }
    Ok(collected)
}

/// One value as SQL Server will bind it. Owned, so the borrow the driver takes
/// outlives the statement.
fn mssql_param(bound: &Bound) -> Box<dyn tiberius::ToSql> {
    match bound {
        Bound::Null => Box::new(Option::<String>::None),
        Bound::Bool(flag) => Box::new(*flag),
        Bound::Int(int) => Box::new(*int),
        Bound::Float(float) => Box::new(*float),
        Bound::Text(text) => Box::new(text.clone()),
    }
}

fn mssql_columns(row: &tiberius::Row) -> Vec<SqlColumnDto> {
    row.columns()
        .iter()
        .map(|column| SqlColumnDto {
            name: column.name().to_owned(),
            type_name: format!("{:?}", column.column_type()),
        })
        .collect()
}

fn mssql_object(row: &tiberius::Row) -> JsonMap<String, Value> {
    let names: Vec<String> = row
        .columns()
        .iter()
        .map(|column| column.name().to_owned())
        .collect();
    let mut object = JsonMap::new();
    for (index, name) in names.into_iter().enumerate() {
        object.insert(name, mssql_value(row, index));
    }
    object
}

/// Decodes one SQL Server column through tiberius' own conversions, in the same
/// first-match-wins order the sqlx drivers use.
fn mssql_value(row: &tiberius::Row, index: usize) -> Value {
    // `Row::try_get` takes its index as `impl QueryIdx`, so the decoded type is
    // pinned by an annotated binding rather than a turbofish.
    macro_rules! tds_chain {
        ( $( $ty:ty => $conv:expr ),+ $(,)? ) => {{
            let mut decoded: Option<Value> = None;
            $(
                if decoded.is_none() {
                    let attempt: tiberius::Result<Option<$ty>> = row.try_get(index);
                    if let Ok(value) = attempt {
                        decoded = Some(value.map_or(Value::Null, $conv));
                    }
                }
            )+
            decoded.unwrap_or(Value::Null)
        }};
    }

    use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    tds_chain!(
        i64 => Value::from,
        i32 => Value::from,
        i16 => Value::from,
        u8 => Value::from,
        f64 => Value::from,
        f32 => Value::from,
        bool => Value::Bool,
        &str => |value: &str| Value::String(value.to_owned()),
        DateTime<Utc> => |value: DateTime<Utc>| Value::String(value.to_rfc3339()),
        NaiveDateTime => |value: NaiveDateTime| Value::String(value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()),
        NaiveDate => |value: NaiveDate| Value::String(value.to_string()),
        NaiveTime => |value: NaiveTime| Value::String(value.to_string()),
        tiberius::numeric::Numeric => |value: tiberius::numeric::Numeric| Value::String(value.to_string()),
        tiberius::Uuid => |value: tiberius::Uuid| Value::String(value.to_string()),
        &[u8] => |value: &[u8]| Value::String(crate::data::base64_encode(value)),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure classification
// ─────────────────────────────────────────────────────────────────────────────

/// Where a driver failure happened. `connect`, `dns` and `tls` are the kinds the
/// engine's retry classifier reads as "the statement provably never ran", so
/// they are only ever reported for a failure that happened while connecting: a
/// mid-statement socket error could have committed a write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Connect,
    Execute,
}

impl Phase {
    fn verb(self) -> &'static str {
        match self {
            Self::Connect => "connect to the database",
            Self::Execute => "run the statement",
        }
    }
}

fn classify_sqlx(phase: Phase, error: &sqlx::Error) -> DataErrorDto {
    classify_error(phase, error, phase.verb())
}

/// Maps a driver failure onto one of the six `TransportFailureKind` values.
fn classify_error(phase: Phase, error: &(dyn StdError + 'static), attempt: &str) -> DataErrorDto {
    let chain = error_chain(error);
    let kind = if chain.contains("timed out") || chain.contains("timeout") {
        "timeout"
    } else if phase == Phase::Connect {
        if chain.contains("dns")
            || chain.contains("resolve")
            || chain.contains("name or service")
            || chain.contains("failed to lookup")
        {
            "dns"
        } else if chain.contains("tls")
            || chain.contains("ssl")
            || chain.contains("certificate")
            || chain.contains("handshake")
        {
            "tls"
        } else {
            "connect"
        }
    } else if chain.contains("cancel") || chain.contains("abort") {
        "aborted"
    } else {
        "unknown"
    };
    transport_error(kind, format!("Could not {attempt} ({kind}): {error}"))
}

/// Lower-cased text of an error and every source under it, so a cause can be
/// told apart without depending on driver internals.
fn error_chain(error: &(dyn StdError + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(current) = source {
        text.push_str(" | ");
        text.push_str(&current.to_string());
        source = current.source();
    }
    text.to_lowercase()
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrubbing
// ─────────────────────────────────────────────────────────────────────────────

/// Replaces every resolved secret inside a returned value, however deeply
/// nested, so a row that happens to echo a credential cannot carry it across
/// IPC (Requirement 3.3).
pub(crate) fn scrub_value(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => *text = scrub(text, secrets),
        Value::Array(items) => {
            for item in items.iter_mut() {
                scrub_value(item, secrets);
            }
        }
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                scrub_value(item, secrets);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::KIND_CONFIG;
    use serde_json::json;

    /// A payload a caller would send to break out of the statement. Every driver
    /// must carry it as data, not as SQL (Requirement 10.4).
    const INJECTION: &str = "'; DROP TABLE users; --";

    fn params(entries: &[(&str, Value)]) -> HashMap<String, Value> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    }

    #[test]
    fn every_driver_family_maps_to_its_own_placeholder_dialect() {
        assert_eq!(
            Driver::parse("postgres").expect("driver").placeholders(),
            Placeholders::Dollar
        );
        assert_eq!(
            Driver::parse("MySQL").expect("driver").placeholders(),
            Placeholders::Question
        );
        assert_eq!(
            Driver::parse(" sqlite ").expect("driver").placeholders(),
            Placeholders::Question
        );
        assert_eq!(
            Driver::parse("mssql").expect("driver").placeholders(),
            Placeholders::AtP
        );

        let error = Driver::parse("oracle").expect_err("unknown driver is rejected");
        assert_eq!(error.kind, KIND_CONFIG, "a pre-I/O rejection is not a transport failure");
        assert!(error.message.contains("oracle"), "{}", error.message);
    }

    /// The whole point of the module: the injection payload reaches the driver as
    /// one bound string, and the statement text the driver sees carries no
    /// `DROP TABLE` — in every one of the four placeholder dialects.
    #[test]
    fn an_injection_payload_binds_as_a_value_for_every_driver() {
        let bound = params(&[("name", json!(INJECTION))]);
        for (driver, expected) in [
            ("postgres", "select id from users where name = $1"),
            ("mysql", "select id from users where name = ?"),
            ("sqlite", "select id from users where name = ?"),
            ("mssql", "select id from users where name = @P1"),
        ] {
            let style = Driver::parse(driver).expect("driver").placeholders();
            let prepared = prepare("select id from users where name = :name", &bound, style)
                .expect("statement prepares");

            assert_eq!(prepared.sql, expected, "{driver} placeholder dialect");
            assert_eq!(
                prepared.binds,
                vec![Bound::Text(INJECTION.to_owned())],
                "{driver} binds the payload as one string"
            );
            assert!(
                !prepared.sql.to_lowercase().contains("drop table"),
                "{driver} statement must carry no injected SQL: {}",
                prepared.sql
            );
        }
    }

    #[test]
    fn a_repeated_parameter_is_reused_by_number_and_rebound_by_position() {
        let bound = params(&[("id", json!(7))]);
        let statement = "update t set a = :id where b = :id";

        let dollar_style = prepare(statement, &bound, Placeholders::Dollar).expect("prepares");
        assert_eq!(dollar_style.sql, "update t set a = $1 where b = $1");
        assert_eq!(dollar_style.binds, vec![Bound::Int(7)]);

        let at_p_style = prepare(statement, &bound, Placeholders::AtP).expect("prepares");
        assert_eq!(at_p_style.sql, "update t set a = @P1 where b = @P1");
        assert_eq!(at_p_style.binds, vec![Bound::Int(7)]);

        // `?` carries no number, so each occurrence needs its own bind.
        let question_style = prepare(statement, &bound, Placeholders::Question).expect("prepares");
        assert_eq!(question_style.sql, "update t set a = ? where b = ?");
        assert_eq!(question_style.binds, vec![Bound::Int(7), Bound::Int(7)]);
    }

    #[test]
    fn a_colon_name_inside_a_literal_a_cast_or_a_comment_is_not_a_parameter() {
        let prepared = prepare(
            "select ':not_a_param', id::text -- :also_not\nfrom t where x = :x",
            &params(&[("x", json!(true))]),
            Placeholders::Dollar,
        )
        .expect("prepares");

        assert_eq!(
            prepared.sql,
            "select ':not_a_param', id::text -- :also_not\nfrom t where x = $1"
        );
        assert_eq!(prepared.binds, vec![Bound::Bool(true)]);
    }

    #[test]
    fn a_parameter_mismatch_or_a_non_scalar_value_is_rejected_before_any_driver_runs() {
        let missing = prepare(
            "select * from t where id = :id",
            &params(&[]),
            Placeholders::Dollar,
        )
        .expect_err("a parameter with no value is rejected");
        assert_eq!(missing.kind, KIND_CONFIG);
        assert!(missing.message.contains(":id"), "{}", missing.message);

        let unused = prepare(
            "select * from t",
            &params(&[("id", json!(1))]),
            Placeholders::Dollar,
        )
        .expect_err("a value no placeholder uses is rejected");
        assert!(unused.message.contains("id"), "{}", unused.message);

        let structural = prepare(
            "select * from t where id = :id",
            &params(&[("id", json!({"nested": 1}))]),
            Placeholders::Question,
        )
        .expect_err("an object cannot be bound");
        assert_eq!(structural.kind, KIND_CONFIG);
        assert!(structural.message.contains("id"), "{}", structural.message);

        let empty = prepare("   ", &params(&[]), Placeholders::Question)
            .expect_err("an empty statement is rejected");
        assert_eq!(empty.kind, KIND_CONFIG);
    }

    /// Requirement 3.3: no resolved secret crosses IPC, in whole or as a
    /// substring, in a row value, a column name or an error message.
    #[test]
    fn resolved_secrets_are_absent_from_rows_columns_and_error_strings() {
        let secret = "pg-password-4f8a-c1".to_owned();
        let values = vec![secret.clone()];

        let mut row = json!({
            "note": format!("connected as svc with {secret}"),
            "nested": [{ "dsn": format!("postgres://svc:{secret}@db.internal/app") }],
            "count": 3,
            "flag": true,
            "nothing": Value::Null,
        });
        scrub_value(&mut row, &values);
        let rendered = serde_json::to_string(&row).expect("row serialises");
        assert!(!rendered.contains(&secret), "{rendered}");
        assert_eq!(rendered.matches("[redacted]").count(), 2);
        assert_eq!(row.get("count"), Some(&json!(3)), "non-text values are untouched");

        let mut column = SqlColumnDto {
            name: format!("col_{secret}"),
            type_name: "TEXT".to_owned(),
        };
        column.name = scrub(&column.name, &values);
        assert!(!column.name.contains(&secret), "{}", column.name);

        let error = classify_sqlx(
            Phase::Connect,
            &sqlx::Error::Configuration(
                format!("password authentication failed for {secret}").into(),
            ),
        );
        let scrubbed = scrub(&error.message, &values);
        assert!(!scrubbed.contains(&secret), "{scrubbed}");
        assert!(scrubbed.contains("[redacted]"), "{scrubbed}");
    }

    #[test]
    fn each_limit_resolves_from_the_request_then_the_connection_then_the_default() {
        let request = |max_rows, connection: Option<SqlLimitsDto>| SqlRequestDto {
            driver: "sqlite".to_owned(),
            statement: "select 1".to_owned(),
            params: HashMap::new(),
            config: HashMap::new(),
            limits: connection,
            max_rows,
            max_result_bytes: None,
            statement_timeout_ms: None,
        };

        assert_eq!(resolve_limits(&request(Some(25), None)).max_rows, 25);
        assert_eq!(
            resolve_limits(&request(
                None,
                Some(SqlLimitsDto {
                    max_rows: Some(50),
                    ..SqlLimitsDto::default()
                })
            ))
            .max_rows,
            50
        );
        // Out of range falls through to the next tier rather than clamping.
        assert_eq!(
            resolve_limits(&request(
                Some(0),
                Some(SqlLimitsDto {
                    max_rows: Some(50),
                    ..SqlLimitsDto::default()
                })
            ))
            .max_rows,
            50
        );
        let defaults = resolve_limits(&request(None, None));
        assert_eq!(defaults.max_rows, DEFAULT_MAX_ROWS);
        assert_eq!(defaults.max_result_bytes, DEFAULT_MAX_RESULT_BYTES);
        assert_eq!(defaults.statement_timeout_ms, DEFAULT_STATEMENT_TIMEOUT_MS);
    }
}
