<script context="module">
	export function preload() {
		return this.fetch(`blog.json`).then(r => r.json()).then(posts => {
			return { posts };
		});
	}
</script>

<script>
	export let posts;
</script>

<ul>
  {#each posts as post}
  <li><a href="amp/{post.slug}">{post.title}</a></li>
  {/each}
</ul>