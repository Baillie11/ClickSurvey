<?php
/**
 * Plugin Name: Puzzle Path ClickSurvey Connector
 * Description: Queues feedback invitations for new completed paid quests, with retries and a 30-day customer limit.
 * Version: 1.0.0
 * Author: Click eCommerce
 */
defined('ABSPATH') || exit;

function pp_cs_table() { global $wpdb; return $wpdb->prefix . 'pp_clicksurvey_outbox'; }
function pp_cs_config() { return (array) get_option('pp_cs_config', array()); }
function pp_cs_ready($config) {
    return ($config['url'] ?? '') === 'https://clickecommerce.com.au/clicksurvey'
        && preg_match('/^cs_[a-f0-9]{24}_[a-f0-9]{40}$/D', $config['key'] ?? '');
}
function pp_cs_install() {
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $table = pp_cs_table();
    dbDelta("CREATE TABLE $table (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        event_key varchar(100) NOT NULL,
        booking_id bigint unsigned NOT NULL,
        email varchar(254) NOT NULL,
        payload longtext NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'pending',
        attempts int unsigned NOT NULL DEFAULT 0,
        next_attempt datetime NOT NULL,
        created_at datetime NOT NULL,
        accepted_at datetime NULL,
        invite_id bigint unsigned NULL,
        last_error varchar(80) NULL,
        PRIMARY KEY  (id),
        UNIQUE KEY event_key (event_key),
        KEY due_jobs (status,next_attempt),
        KEY email_created (email(191),created_at)
    ) " . $wpdb->get_charset_collate() . ';');
    if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) === $table) {
        update_option('pp_cs_schema', '1', false);
    }
}
add_filter('cron_schedules', function($schedules) {
    $schedules['pp_cs_minute'] = array('interval' => 60, 'display' => 'ClickSurvey every minute');
    return $schedules;
});
register_activation_hook(__FILE__, function() {
    pp_cs_install();
    if (!wp_next_scheduled('pp_cs_tick')) wp_schedule_event(time() + 60, 'pp_cs_minute', 'pp_cs_tick');
});
register_deactivation_hook(__FILE__, function() { wp_clear_scheduled_hook('pp_cs_tick'); });
add_action('init', function() {
    if (get_option('pp_cs_schema') !== '1') return;
    if (!wp_next_scheduled('pp_cs_tick')) wp_schedule_event(time() + 60, 'pp_cs_minute', 'pp_cs_tick');
});

function pp_cs_payload($row, $event_id) {
    return array('eventId' => $event_id, 'sourceApp' => 'Puzzle Path', 'eventType' => 'hunt_completed',
        'recipient' => array('email' => strtolower(trim($row->customer_email)), 'name' => (string)$row->customer_name),
        'metadata' => (object) array('bookingId' => (string)$row->id));
}
function pp_cs_send($config, $payload) {
    if (!pp_cs_ready($config)) return new WP_Error('configuration', 'Configure the ClickSurvey connection.');
    $response = wp_remote_post($config['url'] . '/api/events', array('timeout' => 25, 'redirection' => 0,
        'headers' => array('Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . $config['key']),
        'body' => wp_json_encode($payload)));
    if (is_wp_error($response)) return $response;
    $status = wp_remote_retrieve_response_code($response);
    $body = json_decode(wp_remote_retrieve_body($response), true);
    if ($status < 200 || $status >= 300 || !is_array($body) || empty($body['success']) || ($body['eventId'] ?? '') !== $payload['eventId']) {
        return new WP_Error('api_rejected', 'ClickSurvey rejected the request.', array('status' => $status));
    }
    return $body;
}
// Some shared hosts advertise IPv6 without working outbound IPv6 routing.
// Scope IPv4 selection to this connector; HTTPS verification stays enabled.
add_action('http_api_curl',function($handle,$args,$url){
    if($url==='https://clickecommerce.com.au/clicksurvey/api/events' && defined('CURL_IPRESOLVE_V4'))curl_setopt($handle,CURLOPT_IPRESOLVE,CURL_IPRESOLVE_V4);
},10,3);
function pp_cs_enqueue($row, $now) {
    global $wpdb;
    $table = pp_cs_table(); $event_id = 'hunt_completed:' . (int)$row->id;
    if ($wpdb->get_var($wpdb->prepare("SELECT id FROM $table WHERE event_key=%s", $event_id))) return;
    $email = strtolower(trim($row->customer_email));
    $recent = $wpdb->get_var($wpdb->prepare("SELECT id FROM $table WHERE email=%s AND status NOT IN ('throttled','invalid') AND created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY) LIMIT 1", $email));
    $status = !is_email($email) ? 'invalid' : ($recent ? 'throttled' : 'pending');
    $ok = $wpdb->insert($table, array('event_key'=>$event_id, 'booking_id'=>(int)$row->id, 'email'=>$email,
        'payload'=>wp_json_encode(pp_cs_payload($row,$event_id)), 'status'=>$status, 'next_attempt'=>$now, 'created_at'=>$now));
    if ($ok === false) throw new RuntimeException('outbox_insert_failed');
}
function pp_cs_dispatch($config) {
    global $wpdb;
    $table=pp_cs_table();
    $job=$wpdb->get_row("SELECT * FROM $table WHERE status='pending' AND next_attempt<=UTC_TIMESTAMP() ORDER BY next_attempt,id LIMIT 1");
    if (!$job) return false;
    $attempt=(int)$job->attempts+1;
    $delay=min(86400,60*(2 ** min($attempt,10)));
    $claim=$wpdb->query($wpdb->prepare("UPDATE $table SET attempts=%d,next_attempt=DATE_ADD(UTC_TIMESTAMP(),INTERVAL %d SECOND) WHERE id=%d AND status='pending'",$attempt,$delay,$job->id));
    if ($claim !== 1) return false;
    $result=pp_cs_send($config,json_decode($job->payload,true));
    if (is_wp_error($result)) {
        $details=$result->get_error_data();
        $status=is_array($details)?(int)($details['status'] ?? 0):0;
        $retryable=$status===0 || $status===429 || $status>=500;
        $wpdb->update($table,array('status'=>$retryable && $attempt<8 ? 'pending' : 'failed',
            'last_error'=>$status ? 'HTTP_'.$status : 'transport_error'),array('id'=>$job->id));
    } else {
        $wpdb->update($table,array('status'=>!empty($result['inviteCreated'])?'accepted':'no_matching_rule',
            'invite_id'=>$result['inviteId'] ?? null,'accepted_at'=>gmdate('Y-m-d H:i:s'),'last_error'=>null),array('id'=>$job->id));
    }
    return true;
}
function pp_cs_tick() {
    global $wpdb;
    $config=pp_cs_config();
    if (empty($config['enabled']) || !pp_cs_ready($config) || empty($config['activated_at']) || get_option('pp_cs_schema')!=='1') return;
    $lock='pp_cs_'.substr(hash('sha256',ABSPATH),0,24);
    if ((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!==1) return;
    try {
        $table=pp_cs_table();$bookings=$wpdb->prefix.'pp_bookings';$progress=$wpdb->prefix.'pp_booking_progress';
        // Read authoritative paid/completed state; never infer completion from a browser request.
        $rows=$wpdb->get_results($wpdb->prepare("SELECT b.id,b.customer_name,b.customer_email FROM $bookings b JOIN $progress p ON p.booking_id=b.id WHERE b.payment_status='paid' AND p.quest_status='completed' AND p.completed_at>=%s AND NOT EXISTS(SELECT 1 FROM $table o WHERE o.booking_id=b.id) ORDER BY p.completed_at,b.id LIMIT 100",$config['activated_at']));
        if ($wpdb->last_error) throw new RuntimeException('completion_query_failed');
        foreach ($rows as $row) pp_cs_enqueue($row,gmdate('Y-m-d H:i:s'));
        // ClickSurvey collects this queue over authenticated HTTPS. The site's
        // host cannot establish outbound HTTPS to the ClickSurvey host.
        update_option('pp_cs_last_run',gmdate('Y-m-d H:i:s'),false);
        delete_option('pp_cs_last_error');
    } catch (Throwable $error) {
        update_option('pp_cs_last_error','Connector could not complete its last run. Check the queue and booking tables.',false);
    } finally { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock)); }
}
add_action('pp_cs_tick','pp_cs_tick');
function pp_cs_permission($request) {
    $c=pp_cs_config();$header=(string)$request->get_header('authorization');
    return !empty($c['enabled']) && pp_cs_ready($c) && hash_equals('Bearer '.$c['key'],$header);
}
function pp_cs_collect() {
    global $wpdb;nocache_headers();pp_cs_tick();
    $jobs=$wpdb->get_results('SELECT event_key,payload FROM '.pp_cs_table()." WHERE status='pending' AND next_attempt<=UTC_TIMESTAMP() ORDER BY id LIMIT 5");
    return array('events'=>array_map(function($job){return json_decode($job->payload,true);},$jobs));
}
function pp_cs_acknowledge($request) {
    global $wpdb;nocache_headers();$body=$request->get_json_params();$id=(string)($body['eventId']??'');
    $table=pp_cs_table();$job=$wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE event_key=%s",$id));
    if(!$job)return new WP_Error('unknown_event','Unknown queue event',array('status'=>404));
    if($job->status!=='pending')return array('success'=>true,'duplicate'=>true);
    if(!in_array($body['status']??'',array('accepted','no_matching_rule','retry'),true))return new WP_Error('invalid_status','Invalid acknowledgement',array('status'=>400));
    $attempts=(int)$job->attempts+1;$status=$body['status'];
    if($status==='retry' && $attempts>=8)$status='failed';
    $wpdb->update($table,array('status'=>$status==='retry'?'pending':$status,'attempts'=>$attempts,
        'next_attempt'=>gmdate('Y-m-d H:i:s',time()+min(86400,60*(2**min($attempts,10)))),
        'accepted_at'=>$status==='accepted'?gmdate('Y-m-d H:i:s'):null,
        'invite_id'=>isset($body['inviteId'])?(string)absint($body['inviteId']):null,
        'last_error'=>$status==='retry'||$status==='failed'?'collection_delivery_failed':null),array('id'=>$job->id));
    return array('success'=>true);
}
add_action('rest_api_init',function(){
    register_rest_route('puzzlepath-clicksurvey/v1','/events',array('methods'=>'GET','permission_callback'=>'pp_cs_permission','callback'=>'pp_cs_collect'));
    register_rest_route('puzzlepath-clicksurvey/v1','/ack',array('methods'=>'POST','permission_callback'=>'pp_cs_permission','callback'=>'pp_cs_acknowledge'));
});

add_action('admin_menu',function(){add_options_page('ClickSurvey','ClickSurvey','manage_options','puzzlepath-clicksurvey','pp_cs_settings');});
function pp_cs_settings() {
    if(!current_user_can('manage_options')) return;
    global $wpdb;
    $c=pp_cs_config();$queue=get_option('pp_cs_schema')==='1'?$wpdb->get_results('SELECT status,COUNT(*) AS n FROM '.pp_cs_table().' GROUP BY status'):array();
    echo '<div class="wrap"><h1>Puzzle Path → ClickSurvey</h1>';
    if(isset($_GET['saved'])) echo '<div class="notice notice-success"><p>Connection saved.</p></div>';
    if(isset($_GET['test'])) echo '<div class="notice '.($_GET['test']==='sent'?'notice-success':'notice-error').'"><p>'.($_GET['test']==='sent'?'Test invitation queued successfully. Check ClickSurvey Delivery and the test mailbox.':'Test request failed. Check the URL, API key and matching active automation rule.').'</p></div>';
    echo '<p>Secure scheduled collection: ClickSurvey checks this queue every minute over authenticated HTTPS.</p>';
    echo '<p>New completed, paid quests only. One invitation per email address in 30 days. Historical completions are excluded. Check ClickSurvey Delivery for email status.</p>';
    echo '<form method="post" action="'.esc_url(admin_url('admin-post.php')).'"><input type="hidden" name="action" value="pp_cs_save">';wp_nonce_field('pp_cs_save');
    echo '<table class="form-table"><tr><th><label for="pp-cs-url">ClickSurvey URL</label></th><td><input class="regular-text" id="pp-cs-url" name="url" type="url" required value="'.esc_attr($c['url']??'https://clickecommerce.com.au/clicksurvey').'"></td></tr>';
    echo '<tr><th><label for="pp-cs-key">API key</label></th><td><input class="regular-text" id="pp-cs-key" name="key" type="password" autocomplete="new-password" value=""><p>'.(!empty($c['key'])?'Configured. Leave blank to keep the current key.':'Not configured. Paste the Puzzle Path key.').'</p></td></tr>';
    echo '<tr><th><label for="pp-cs-enabled">Automatic requests</label></th><td><label><input id="pp-cs-enabled" name="enabled" type="checkbox" value="1" '.checked(!empty($c['enabled']),true,false).'> Enable new quest-completion requests</label></td></tr></table>';
    submit_button('Save connection');echo '</form>';
    echo '<p>Activated (UTC): '.esc_html($c['activated_at']??'Not activated').'<br>Last worker run (UTC): '.esc_html(get_option('pp_cs_last_run','Not run yet')).'</p>';
    if(get_option('pp_cs_last_error'))echo '<p>'.esc_html(get_option('pp_cs_last_error')).'</p>';
    echo '<h2>Queue</h2><ul>';foreach($queue as $q)echo '<li>'.esc_html($q->status).': '.(int)$q->n.'</li>';echo '</ul>';
    echo '<form method="post" action="'.esc_url(admin_url('admin-post.php')).'"><input type="hidden" name="action" value="pp_cs_run">';wp_nonce_field('pp_cs_run');submit_button('Check new completions now','secondary');echo '</form>';
    echo '<h2>Test connection</h2><form method="post" action="'.esc_url(admin_url('admin-post.php')).'"><input type="hidden" name="action" value="pp_cs_test">';wp_nonce_field('pp_cs_test');
    echo '<label for="pp-cs-test-email">Your test email</label> <input id="pp-cs-test-email" name="email" type="email" required>';submit_button('Send test invitation','secondary');echo '</form></div>';
}
add_action('admin_post_pp_cs_save',function(){
    if(!current_user_can('manage_options')) wp_die('Not permitted','',array('response'=>403));
    check_admin_referer('pp_cs_save');$c=pp_cs_config();
    $c['url']=untrailingslashit(esc_url_raw(wp_unslash($_POST['url']??'')));
    $key=trim(wp_unslash($_POST['key']??''));if($key!=='')$c['key']=$key;
    if(!pp_cs_ready($c))wp_die('Use the live ClickSurvey HTTPS URL and a valid Puzzle Path API key.');
    $c['enabled']=!empty($_POST['enabled']);
    if($c['enabled']&&empty($c['activated_at']))$c['activated_at']=gmdate('Y-m-d H:i:s');
    update_option('pp_cs_config',$c,false);
    wp_safe_redirect(admin_url('options-general.php?page=puzzlepath-clicksurvey&saved=1'));exit;
});
add_action('admin_post_pp_cs_test',function(){
    if(!current_user_can('manage_options'))wp_die('Not permitted','',array('response'=>403));
    check_admin_referer('pp_cs_test');$email=sanitize_email(wp_unslash($_POST['email']??''));if(!is_email($email))wp_die('A valid test email is required.');
    $event_id='connection_test:'.wp_generate_uuid4();
    $payload=array('eventId'=>$event_id,'sourceApp'=>'Puzzle Path','eventType'=>'hunt_completed',
        'recipient'=>array('email'=>$email,'name'=>'Puzzle Path connection test'),'metadata'=>(object)array('purpose'=>'Connection verification'));
    global $wpdb;$ok=(bool)$wpdb->insert(pp_cs_table(),array('event_key'=>$event_id,'booking_id'=>0,'email'=>$email,'payload'=>wp_json_encode($payload),'status'=>'pending','attempts'=>0,'next_attempt'=>gmdate('Y-m-d H:i:s'),'created_at'=>gmdate('Y-m-d H:i:s')));
    wp_safe_redirect(admin_url('options-general.php?page=puzzlepath-clicksurvey&test='.($ok?'sent':'failed')));exit;
});
add_action('admin_post_pp_cs_run',function(){
    if(!current_user_can('manage_options'))wp_die('Not permitted','',array('response'=>403));
    check_admin_referer('pp_cs_run');pp_cs_tick();
    wp_safe_redirect(admin_url('options-general.php?page=puzzlepath-clicksurvey'));exit;
});
