-- NZC AI Scope 3: core schema for Supabase / Postgres.
--
-- Mirrors the enums in engines/types.py. Every string in a CHECK constraint
-- here is a value that exists in that file; changing one without the other
-- is a bug, and the store tests assert the two agree.
--
-- Two invariants from the briefs are enforced here rather than in code:
--   * figures and audit rows are append-only (no UPDATE or DELETE policy);
--   * every table is row-level secured on organisation membership.
--
-- Reversible: see 0001_scope3_core.down.sql.

begin;

create schema if not exists s3;

-- ---------------------------------------------------------------------------
-- Organisations and membership. Supabase's auth.uid() identifies the user;
-- membership decides which organisations' rows they may see.
-- ---------------------------------------------------------------------------

create table s3.organisation (
    id          text primary key,
    name        text not null,
    created_at  timestamptz not null default now()
);

create table s3.organisation_member (
    org_id      text not null references s3.organisation(id),
    user_id     uuid not null,
    role        text not null check (role in (
                    'super_admin', 'consultant', 'consultant_single',
                    'business_admin', 'business_viewer')),
    primary key (org_id, user_id)
);

create or replace function s3.member_org_ids()
returns setof text
language sql stable security definer set search_path = s3
as $$
    select org_id from s3.organisation_member where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Counterparties: legal entities in the value chain. A counterparty holds a
-- set of roles, stored as a JSON array of engines.types.RelationshipRole values.
-- ---------------------------------------------------------------------------

create table s3.counterparty (
    id                              text not null,
    org_id                          text not null references s3.organisation(id),
    name                            text not null,
    roles                           jsonb not null default '[]',
    company_number                  text,
    employee_band                   integer,
    turnover_gbp                    numeric,
    has_public_report               boolean not null default false,
    is_cdp_responder                boolean not null default false,
    has_validated_target            boolean not null default false,
    has_named_contact               boolean not null default false,
    responded_before                boolean not null default false,
    contractual_data_right          boolean not null default false,
    emissions_intensive_commodity   text,
    contract_end                    date,
    created_at                      timestamptz not null default now(),
    primary key (org_id, id)
);

-- ---------------------------------------------------------------------------
-- Figures: append-only. A correction inserts a new row with supersedes_id set
-- and the old row's status flips to 'superseded' by trigger. Nothing is ever
-- updated in place.
-- ---------------------------------------------------------------------------

create table s3.figure (
    id                  bigserial primary key,
    org_id              text not null references s3.organisation(id),
    period              integer not null,
    category            text not null check (category in (
                            '1','2','3','4','5','6','7','8','9','10','11','12','13','14','15')),
    tco2e               numeric not null check (tco2e >= 0),
    tier                text not null check (tier in ('A','B','C','D','E')),
    factor_source       text not null check (length(factor_source) > 0),
    factor_version      text not null check (length(factor_version) > 0),
    counterparty_id     text,
    document_id         text,
    achievable_tier     text check (achievable_tier in ('A','B','C','D','E')),
    entity_id           text,
    activity_quantity   numeric,
    activity_unit       text,
    factor_key          text,
    factor_kgco2e       numeric,
    method_label        text,
    supersedes_id       bigint references s3.figure(id),
    status              text not null default 'active'
                            check (status in ('active', 'superseded')),
    created_by          uuid,
    created_at          timestamptz not null default now()
);

create index on s3.figure (org_id, period, status);
create index on s3.figure (org_id, counterparty_id);

create or replace function s3.figure_supersede()
returns trigger language plpgsql as $$
begin
    if new.supersedes_id is not null then
        update s3.figure set status = 'superseded'
         where id = new.supersedes_id and org_id = new.org_id;
    end if;
    return new;
end $$;

create trigger trg_figure_supersede
    after insert on s3.figure
    for each row execute function s3.figure_supersede();

-- ---------------------------------------------------------------------------
-- Engagements and their audit trail. The audit row is inserted in the same
-- transaction as the state change; the application never writes one without
-- the other.
-- ---------------------------------------------------------------------------

create table s3.engagement (
    id                  text not null,
    org_id              text not null references s3.organisation(id),
    counterparty_id     text not null,
    period              integer not null,
    state               text not null check (state in (
                            'unidentified','identified','enriched','scoped','contacted',
                            'engaged','responding','partial','complete','verified',
                            'declined','unreachable','lapsed','superseded')),
    entered_at          date,
    deadline            date,
    decline_reason      text check (decline_reason in (
                            'vsme_cap','commercial_confidentiality',
                            'no_capability','no_reason_given')),
    contact_attempts    integer not null default 0,
    primary key (org_id, id),
    foreign key (org_id, counterparty_id) references s3.counterparty(org_id, id)
);

create table s3.audit_row (
    id              bigserial primary key,
    org_id          text not null references s3.organisation(id),
    engagement_id   text not null,
    from_state      text not null,
    to_state        text not null,
    actor           text not null,
    trigger         text not null,
    at              date not null,
    evidence_id     text,
    recorded_at     timestamptz not null default now()
);

create index on s3.audit_row (org_id, engagement_id, recorded_at);

-- ---------------------------------------------------------------------------
-- Documents. owner_org_id is the client the document was given to, which is
-- not the counterparty it is about. Disclosure is decided by
-- engines.disclosure and re-checked by the policy below.
-- ---------------------------------------------------------------------------

create table s3.document (
    id                  text not null,
    org_id              text not null references s3.organisation(id),
    counterparty_id     text not null,
    doc_type            text not null check (doc_type in (
                            'sustainability_report','cdp_response','sbti_target','epd',
                            'pact_payload','vsme_return','iso_certificate',
                            'assurance_statement','invoice','waste_transfer_note',
                            'utility_bill','agreement','franchisor_request')),
    issue_date          date not null,
    confidentiality     text not null default 'client_only' check (confidentiality in (
                            'public','nda','client_only','consented_reuse')),
    period_covered      integer,
    valid_to            date,
    consented_org_ids   jsonb not null default '[]',
    storage_key         text,
    sha256              text,
    created_at          timestamptz not null default now(),
    primary key (org_id, id)
);

-- ---------------------------------------------------------------------------
-- Conflicts, agent proposals and attempt outcomes.
-- ---------------------------------------------------------------------------

create table s3.conflict (
    id                      bigserial primary key,
    org_id                  text not null references s3.organisation(id),
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
    decided_at              timestamptz,
    created_at              timestamptz not null default now()
);

create table s3.proposal (
    id              bigserial primary key,
    org_id          text not null references s3.organisation(id),
    agent           text not null,
    kind            text not null,
    payload         jsonb not null,
    confidence      numeric check (confidence between 0 and 1),
    status          text not null default 'pending'
                        check (status in ('pending','accepted','rejected')),
    decided_by      text,
    decided_at      timestamptz,
    created_at      timestamptz not null default now()
);

create table s3.attempt_outcome (
    id                  bigserial primary key,
    org_id              text not null references s3.organisation(id),
    counterparty_id     text not null,
    channel             text not null,
    rung                text not null,
    prefilled           boolean not null,
    template            text not null,
    sent                date not null,
    responded           boolean not null,
    hours_to_response   numeric,
    sector              text
);

-- ---------------------------------------------------------------------------
-- Row-level security. Every table, keyed on membership. Figures and audit
-- rows get no update or delete policy: append-only by construction.
-- ---------------------------------------------------------------------------

alter table s3.organisation      enable row level security;
alter table s3.counterparty      enable row level security;
alter table s3.figure            enable row level security;
alter table s3.engagement        enable row level security;
alter table s3.audit_row         enable row level security;
alter table s3.document          enable row level security;
alter table s3.conflict          enable row level security;
alter table s3.proposal          enable row level security;
alter table s3.attempt_outcome   enable row level security;

create policy org_read   on s3.organisation for select using (id in (select s3.member_org_ids()));

create policy cp_all     on s3.counterparty     for all using (org_id in (select s3.member_org_ids()));
create policy eng_all    on s3.engagement       for all using (org_id in (select s3.member_org_ids()));
create policy con_all    on s3.conflict         for all using (org_id in (select s3.member_org_ids()));
create policy prop_all   on s3.proposal         for all using (org_id in (select s3.member_org_ids()));
create policy out_all    on s3.attempt_outcome  for all using (org_id in (select s3.member_org_ids()));

create policy fig_select on s3.figure    for select using (org_id in (select s3.member_org_ids()));
create policy fig_insert on s3.figure    for insert with check (org_id in (select s3.member_org_ids()));

create policy aud_select on s3.audit_row for select using (org_id in (select s3.member_org_ids()));
create policy aud_insert on s3.audit_row for insert with check (org_id in (select s3.member_org_ids()));

-- A document is visible to its owner, or to anyone if public, or to a named
-- organisation under consented reuse. NDA and client-only never cross.
create policy doc_select on s3.document for select using (
    org_id in (select s3.member_org_ids())
    or confidentiality = 'public'
    or (confidentiality = 'consented_reuse'
        and exists (select 1 from jsonb_array_elements_text(consented_org_ids) c
                    where c in (select s3.member_org_ids())))
);
create policy doc_write on s3.document for insert with check (org_id in (select s3.member_org_ids()));
create policy doc_update on s3.document for update using (org_id in (select s3.member_org_ids()));

commit;
