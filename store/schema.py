"""SQLite schema for the working store.

The Postgres migration in migrations/ is the production target. This is the
same model in SQLite, used for local runs and tests. Row-level security has
no SQLite equivalent, so every query in repository.py takes an org_id and
filters on it; the tests prove an organisation cannot read another's rows.

Append-only invariants are enforced by triggers here as they are in Postgres.
"""

SCHEMA = """
create table if not exists organisation (
    id          text primary key,
    name        text not null
);

create table if not exists counterparty (
    id                              text not null,
    org_id                          text not null references organisation(id),
    name                            text not null,
    roles                           text not null default '[]',
    company_number                  text,
    employee_band                   integer,
    turnover_gbp                    real,
    has_public_report               integer not null default 0,
    is_cdp_responder                integer not null default 0,
    has_validated_target            integer not null default 0,
    has_named_contact               integer not null default 0,
    responded_before                integer not null default 0,
    contractual_data_right          integer not null default 0,
    emissions_intensive_commodity   text,
    contract_end                    text,
    primary key (org_id, id)
);

create table if not exists figure (
    id                  integer primary key autoincrement,
    org_id              text not null references organisation(id),
    period              integer not null,
    category            text not null,
    tco2e               real not null check (tco2e >= 0),
    tier                text not null,
    factor_source       text not null check (length(factor_source) > 0),
    factor_version      text not null check (length(factor_version) > 0),
    counterparty_id     text,
    document_id         text,
    achievable_tier     text,
    entity_id           text,
    activity_quantity   real,
    activity_unit       text,
    factor_key          text,
    factor_kgco2e       real,
    method_label        text,
    supersedes_id       integer references figure(id),
    status              text not null default 'active' check (status in ('active','superseded')),
    created_by          text,
    created_at          text not null default (datetime('now'))
);
create index if not exists ix_figure_org_period on figure (org_id, period, status);

create trigger if not exists trg_figure_no_update
    before update on figure
begin
    select case when old.status = new.status or new.status <> 'superseded'
        then raise(abort, 'figures are append-only') end;
end;

create trigger if not exists trg_figure_no_delete
    before delete on figure
begin
    select raise(abort, 'figures are append-only');
end;

create trigger if not exists trg_figure_supersede
    after insert on figure when new.supersedes_id is not null
begin
    update figure set status = 'superseded'
     where id = new.supersedes_id and org_id = new.org_id;
end;

create table if not exists engagement (
    id                  text not null,
    org_id              text not null references organisation(id),
    counterparty_id     text not null,
    period              integer not null,
    state               text not null,
    entered_at          text,
    deadline            text,
    decline_reason      text,
    contact_attempts    integer not null default 0,
    primary key (org_id, id)
);

create table if not exists audit_row (
    id              integer primary key autoincrement,
    org_id          text not null references organisation(id),
    engagement_id   text not null,
    from_state      text not null,
    to_state        text not null,
    actor           text not null,
    trigger         text not null,
    at              text not null,
    evidence_id     text,
    recorded_at     text not null default (datetime('now'))
);
create index if not exists ix_audit_org_eng on audit_row (org_id, engagement_id, id);

create trigger if not exists trg_audit_no_update
    before update on audit_row
begin select raise(abort, 'audit rows are append-only'); end;

create trigger if not exists trg_audit_no_delete
    before delete on audit_row
begin select raise(abort, 'audit rows are append-only'); end;

create table if not exists document (
    id                  text not null,
    org_id              text not null references organisation(id),
    counterparty_id     text not null,
    doc_type            text not null,
    issue_date          text not null,
    confidentiality     text not null default 'client_only',
    period_covered      integer,
    valid_to            text,
    consented_org_ids   text not null default '[]',
    storage_key         text,
    sha256              text,
    primary key (org_id, id)
);

create table if not exists conflict (
    id                      integer primary key autoincrement,
    org_id                  text not null references organisation(id),
    conflict_class          text not null,
    subject                 text not null,
    value_a                 text not null,
    source_a                text not null,
    value_b                 text not null,
    source_b                text not null,
    proposed_resolution     text not null,
    rationale               text not null,
    decision                text,
    decided_by              text,
    decided_at              text,
    created_at              text not null default (datetime('now'))
);

create table if not exists proposal (
    id              integer primary key autoincrement,
    org_id          text not null references organisation(id),
    agent           text not null,
    kind            text not null,
    payload         text not null,
    confidence      real,
    status          text not null default 'pending' check (status in ('pending','accepted','rejected')),
    decided_by      text,
    decided_at      text,
    created_at      text not null default (datetime('now'))
);

create table if not exists attempt_outcome (
    id                  integer primary key autoincrement,
    org_id              text not null references organisation(id),
    counterparty_id     text not null,
    channel             text not null,
    rung                text not null,
    prefilled           integer not null,
    template            text not null,
    sent                text not null,
    responded           integer not null,
    hours_to_response   real,
    sector              text
);
"""
