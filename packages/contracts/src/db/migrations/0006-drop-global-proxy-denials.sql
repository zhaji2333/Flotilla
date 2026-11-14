-- Global proxy denial audit had no mission foreign key and therefore could not
-- be included in project deletion. Remove it entirely; target/internet policy
-- still blocks requests at the proxy, and successful traffic remains audited in
-- proxy_traffic.
BEGIN;
DROP TABLE IF EXISTS proxy_denials;
COMMIT;
