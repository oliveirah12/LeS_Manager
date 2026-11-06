UPDATE "Profile"
SET "permissions" = array_append("permissions", 'registrations:view')
WHERE 'catalog:view' = ANY("permissions") AND NOT ('registrations:view' = ANY("permissions"));

UPDATE "Profile"
SET "permissions" = array_append("permissions", 'registrations:operate')
WHERE 'catalog:operate' = ANY("permissions") AND NOT ('registrations:operate' = ANY("permissions"));
