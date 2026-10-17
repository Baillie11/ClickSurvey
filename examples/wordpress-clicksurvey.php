<?php
/**
 * Plugin Name: ClickSurvey Event Client
 * Description: Server-side ClickSurvey client. Wire clicksurvey_request() to your business event hook.
 * Define CLICKSURVEY_URL and CLICKSURVEY_API_KEY in wp-config.php.
 */
if (!defined('ABSPATH')) { exit; }

/** Reuse the same stable $event_id and payload for every retry. Returns array|WP_Error. */
function clicksurvey_request($event_id, $source_app, $event_type, $email, $name = null, $metadata = array()) {
    if (!defined('CLICKSURVEY_URL') || !defined('CLICKSURVEY_API_KEY')) {
        return new WP_Error('clicksurvey_config', 'Configure ClickSurvey URL and server-side key.');
    }
    if (wp_parse_url(CLICKSURVEY_URL, PHP_URL_SCHEME) !== 'https') {
        return new WP_Error('clicksurvey_https', 'ClickSurvey URL must use HTTPS.');
    }
    $response = wp_remote_post(rtrim(CLICKSURVEY_URL, '/') . '/api/events', array(
        'timeout' => 10,
        'redirection' => 0,
        'headers' => array('Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . CLICKSURVEY_API_KEY),
        'body' => wp_json_encode(array(
            'eventId' => (string) $event_id,
            'sourceApp' => $source_app,
            'eventType' => $event_type,
            'recipient' => array('email' => $email, 'name' => $name),
            'metadata' => (object) $metadata,
        )),
    ));
    if (is_wp_error($response)) { return $response; }
    $status = wp_remote_retrieve_response_code($response);
    $body = json_decode(wp_remote_retrieve_body($response), true);
    if ($status < 200 || $status >= 300 || !is_array($body) || empty($body['success'])) {
        return new WP_Error('clicksurvey_rejected', 'Survey request was rejected.', array('status' => $status));
    }
    if (empty($body['inviteCreated'])) {
        return new WP_Error('clicksurvey_no_rule', 'Event recorded but no matching survey rule was active.');
    }
    return $body; // Accepted/queued, not confirmation of email delivery.
}
