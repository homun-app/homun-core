-- Contacts: change default response_mode from "automatic" to "" (inherit from channel).
--
-- Previously, contacts defaulted to "automatic" which bypassed the channel's
-- "assisted" mode. Now "" means "inherit from channel config", so a contact
-- on an "assisted" channel will correctly require approval.
UPDATE contacts SET response_mode = '' WHERE response_mode = 'automatic';
